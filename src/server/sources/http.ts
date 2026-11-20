import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import type { MetadataUsageDto } from "../../shared/types.ts";
import * as httpCache from "../db/repo/httpCache.ts";
import * as httpCalls from "../db/repo/httpCalls.ts";

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

/** Pace for one host: minimum time between request starts (one request in flight at a time). */
export interface HostLimit {
  /** Service name shown to the user. */
  readonly name?: string;
  readonly intervalMs: number;
  /** Faster pace allowed once the requests carry a contact email (Open Library, Crossref polite pool). */
  readonly identifiedIntervalMs?: number;
  /** Published limit in requests per second (display only; null = none published). */
  readonly perSecond?: number | null;
  readonly identifiedPerSecond?: number;
  /** Calls allowed per UTC day (ISBNdb); requests beyond it fail with QuotaExceededError instead of being sent. */
  readonly dailyLimit?: number;
}

/**
 * Published limits, with a margin (as of 2026):
 * - Open Library: 1 req/s, or 3 req/s with a User-Agent naming a contact.
 * - Covers by cover ID are not rate-limited; stay at 1 req/s anyway.
 * - Crossref: searches 1 req/s public, 3 req/s polite (mailto); single DOIs 5 / 10 req/s.
 *   Crossref also advertises its current limit in X-Rate-Limit-* headers, which tighten the pace.
 * - doi.org content negotiation: no published limit; 1 req/s.
 * - Wikidata: the API has no fixed limit for serial reads; the query service allows 60 s of query
 *   time per minute. Author lookups are rare and one at a time; 2 req/s and 1 req/s.
 * `perSecond` is the published limit shown in the usage summary (for Crossref, the stricter search one).
 */
export const HOST_LIMITS: Readonly<Record<string, HostLimit>> = {
  "openlibrary.org": { name: "Open Library", intervalMs: 1100, identifiedIntervalMs: 500, perSecond: 1, identifiedPerSecond: 3 },
  "covers.openlibrary.org": { name: "Open Library covers", intervalMs: 1000, perSecond: null },
  "api.crossref.org": { name: "Crossref", intervalMs: 1100, identifiedIntervalMs: 500, perSecond: 1, identifiedPerSecond: 3 },
  "doi.org": { name: "doi.org", intervalMs: 1000, perSecond: null },
  "www.wikidata.org": { name: "Wikidata", intervalMs: 500, perSecond: null },
  "query.wikidata.org": { name: "Wikidata Query Service", intervalMs: 1000, perSecond: null },
};

/** ISBNdb's API host (Basic plan); its limits come from the config file, so it isn't in HOST_LIMITS. */
export const ISBNDB_HOST = "api2.isbndb.com";
/** Where ISBNdb's cover images are served (downloads cost no API quota; no published limit). */
export const ISBNDB_IMAGES_HOST = "images.isbndb.com";

/** ISBNdb's pace and daily quota, from the plan's limits in the config file (with a 10 % margin on the pace). */
export function isbndbLimit(plan: { perSecond: number; dailyLimit: number }): Record<string, HostLimit> {
  return {
    [ISBNDB_HOST]: { name: "ISBNdb", intervalMs: Math.ceil((1000 / plan.perSecond) * 1.1), perSecond: plan.perSecond, dailyLimit: plan.dailyLimit },
    [ISBNDB_IMAGES_HOST]: { name: "ISBNdb covers", intervalMs: 500, perSecond: null },
  };
}

/** Names of services whose limits are configured rather than fixed. */
const OTHER_NAMES: Readonly<Record<string, string>> = { [ISBNDB_HOST]: "ISBNdb", [ISBNDB_IMAGES_HOST]: "ISBNdb covers" };

/** Name of a metadata service for messages ("Open Library"), or the host itself. */
export const serviceName = (host: string): string => HOST_LIMITS[host]?.name ?? OTHER_NAMES[host] ?? host;

/** Extra request details: headers (an API key), and what the request costs against a daily quota. */
export interface RequestOptions {
  readonly headers?: Record<string, string>;
  /** Daily-quota calls this request is charged (default 1; 0 for requests outside the quota). */
  readonly cost?: number;
}

export interface HttpClientOptions {
  /** Pace for hosts not in `hostLimits`. */
  minIntervalMs?: number;
  hostLimits?: Record<string, HostLimit>;
  timeoutMs?: number;
  /** Cache lifetime for successful responses and for 404s. */
  okTtlMs?: number;
  notFoundTtlMs?: number;
  retries?: number;
  /** Longest a request waits for a host's rate-limit cooldown before failing with RateLimitedError. */
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/**
 * A service's daily quota is used up (by our count, or as the service reports it): nothing more is
 * sent to `host` before `resetAt` (epoch ms). Callers fall back to other services instead of waiting.
 */
export class QuotaExceededError extends HttpError {
  constructor(readonly host: string, readonly resetAt: number) {
    super(`${serviceName(host)}'s daily limit is used up until ${new Date(resetAt).toISOString().slice(11, 16)} UTC`, 429);
  }
}

/** A service asked us to slow down; no request is sent to `host` before `retryAt` (epoch ms). */
export class RateLimitedError extends HttpError {
  constructor(readonly host: string, readonly retryAt: number, now: number) {
    super(`${host} asked us to slow down; try again in ${formatWait(retryAt - now)}`, 429);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** Call records are kept this long (session counts reach back at most this far). */
const CALL_RETENTION_MS = 25 * HOUR;
/** Cooldown after a 429 without Retry-After: 1 min, doubling per consecutive 429, at most 30 min. */
const BASE_COOLDOWN_MS = MINUTE;
const MAX_COOLDOWN_MS = 30 * MINUTE;
/** Retry-After values are honoured up to this long. */
const MAX_RETRY_AFTER_MS = 60 * MINUTE;

function formatWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  return m < 60 ? `about ${m} min` : `about ${Math.round(m / 6) / 10} h`;
}

/** Retry-After is either seconds or an HTTP date. */
function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** "X-Rate-Limit-Limit: 5" + "X-Rate-Limit-Interval: 1s" → ms between requests (+10 % margin). */
function advertisedInterval(headers: Headers): number | null {
  const limit = Number(headers.get("x-rate-limit-limit"));
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(headers.get("x-rate-limit-interval")?.trim() ?? "");
  if (!(limit > 0) || !m) return null;
  const unit = m[2] === "ms" ? 1 : m[2] === "m" ? MINUTE : 1000;
  return Math.ceil(((Number(m[1]) * unit) / limit) * 1.1);
}

/**
 * IETF RateLimit header, as ISBNdb sends it: `"rate";r=297;t=0` and `"daily";r=48999;t=56312`
 * (one per line, or joined with commas): requests left (`r`) and seconds until the window resets (`t`).
 */
export function parseRateLimit(value: string | null): Map<string, { left: number; resetSeconds: number }> {
  const out = new Map<string, { left: number; resetSeconds: number }>();
  for (const m of (value ?? "").matchAll(/"([^"]+)"\s*;\s*r=(\d+)\s*;\s*t=(\d+)/g)) {
    out.set(m[1]!, { left: Number(m[2]), resetSeconds: Number(m[3]) });
  }
  return out;
}

/** Start of the UTC day containing `at` (daily quotas reset at 00:00 UTC). */
const utcDayStart = (at: number) => Math.floor(at / DAY) * DAY;

type Priority = "interactive" | "background";

interface Waiter {
  priority: Priority;
  wake: () => void;
}

/** What a service last reported as left of its daily quota. */
interface ReportedQuota {
  readonly left: number;
  readonly resetAt: number;
}

/** Per-host state: one request at a time, starts spaced out, cooldown after a 429. Owned by one client. */
interface HostState {
  busy: boolean;
  waiters: Waiter[];
  nextStart: number;
  blockedUntil: number;
  strikes: number;
  advertisedMs: number;
  reportedDaily: ReportedQuota | null;
}

// ---- pacing and quota rules ------------------------------------------------------

/** Minimum time between request starts to a host: its limit (faster once identified), or what it advertises. */
export function paceInterval(limit: HostLimit | undefined, defaultMs: number, identified: boolean, advertisedMs: number): number {
  const base = !limit ? defaultMs : identified && limit.identifiedIntervalMs ? limit.identifiedIntervalMs : limit.intervalMs;
  return Math.max(base, advertisedMs);
}

/** How long a host is left alone after a 429: its Retry-After (capped), else 1 min doubling per consecutive 429 (at most 30 min). */
export function cooldownMs(retryAfterMs: number | null, strikes: number): number {
  return retryAfterMs !== null ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : Math.min(BASE_COOLDOWN_MS * 2 ** (strikes - 1), MAX_COOLDOWN_MS);
}

/** Calls left today: the lower of our own count and the service's report; null when there's no daily quota. */
export function quotaRemaining(dailyLimit: number | undefined, spent: number, reported: ReportedQuota | null): number | null {
  const own = dailyLimit ? Math.max(0, dailyLimit - spent) : null;
  if (own === null) return reported?.left ?? null;
  return reported ? Math.min(own, reported.left) : own;
}

/** When `cost` more calls would go past a daily quota, the time it resets; null when the request may be sent. */
export function quotaBlockedUntil(cost: number, dailyLimit: number | undefined, spent: number, reported: ReportedQuota | null, now: number): number | null {
  if (cost <= 0) return null;
  if (dailyLimit && spent + cost > dailyLimit) return utcDayStart(now) + DAY;
  if (reported && reported.left < cost) return reported.resetAt;
  return null;
}

/** Where a new waiter joins a host's queue: interactive requests go before queued background ones. */
export function queuePosition(waiters: readonly { priority: Priority }[], priority: Priority): number {
  const i = priority === "interactive" ? waiters.findIndex((w) => w.priority === "background") : -1;
  return i < 0 ? waiters.length : i;
}

/** What a response's headers say about the pace and quotas. */
export interface RateHeaders {
  /** Interval derived from X-Rate-Limit-* (Crossref). */
  readonly advertisedMs: number | null;
  readonly daily: ReportedQuota | null;
  /** The rate window is spent: no request before this time. */
  readonly rateResetAt: number | null;
  /** Retry-After, or the time until the spent rate window resets. */
  readonly retryAfterMs: number | null;
}

export function readRateHeaders(headers: Headers, now: number): RateHeaders {
  const limits = parseRateLimit(headers.get("ratelimit"));
  const daily = limits.get("daily");
  const rate = limits.get("rate");
  const windowWait = rate && rate.left === 0 ? rate.resetSeconds * 1000 : null;
  return {
    advertisedMs: advertisedInterval(headers),
    daily: daily ? { left: daily.left, resetAt: now + daily.resetSeconds * 1000 } : null,
    rateResetAt: windowWait === null ? null : now + windowWait,
    retryAfterMs: parseRetryAfter(headers.get("retry-after"), now) ?? windowWait,
  };
}

/** Whether a cached answer is still good: successful ones live longer than 404s. */
export function isFresh(status: number, fetchedAt: string, now: number, ttl: { okTtlMs: number; notFoundTtlMs: number }): boolean {
  return now - Date.parse(fetchedAt) <= (status === 200 ? ttl.okTtlMs : ttl.notFoundTtlMs);
}

export interface UsageInput {
  readonly now: number;
  readonly identified: boolean;
  readonly hostLimits: Readonly<Record<string, HostLimit>>;
  /** Calls per host (hosts without calls may be missing). */
  readonly counts: readonly { readonly host: string; readonly calls: number; readonly lastHour: number }[];
  readonly cooldowns: ReadonlyMap<string, number>;
  /** Today's spending, for hosts with a daily quota. */
  readonly spentToday: ReadonlyMap<string, number>;
  readonly reported: ReadonlyMap<string, ReportedQuota>;
}

/** The usage summary: every known host, then any other host that was called. */
export function usageSummary(u: UsageInput): MetadataUsageDto {
  const counted = new Map(u.counts.map((c) => [c.host, c]));
  const hosts = [...new Set([...Object.keys(u.hostLimits), ...counted.keys()])];
  return {
    now: u.now,
    identified: u.identified,
    services: hosts.map((host) => {
      const limit = u.hostLimits[host];
      const perSecond = (u.identified && limit?.identifiedPerSecond) || limit?.perSecond || null;
      const until = u.cooldowns.get(host);
      const dailyLimit = limit?.dailyLimit ?? null;
      return {
        host,
        name: serviceName(host),
        calls: counted.get(host)?.calls ?? 0,
        lastHour: counted.get(host)?.lastHour ?? 0,
        perSecond,
        hourLimit: perSecond ? perSecond * 3600 : null,
        coolingDownUntil: until ? new Date(until).toISOString() : null,
        dailyLimit,
        today: dailyLimit ? (u.spentToday.get(host) ?? 0) : 0,
        reportedLeft: u.reported.get(host)?.left ?? null,
        quotaResetsAt: dailyLimit ? new Date(utcDayStart(u.now) + DAY).toISOString() : null,
      };
    }),
  };
}

// ---- call log ----------------------------------------------------------------------

/** Where sent requests are counted: the database, or memory when there is none (tests). */
interface CallLog {
  record(host: string, at: number, cost: number): void;
  prune(before: number): void;
  counts(since: number, hourAgo: number): { host: string; calls: number; lastHour: number }[];
  spent(host: string, from: number): number;
}

function dbCallLog(db: Database): CallLog {
  return {
    record: (host, at, cost) => httpCalls.record(db, host, at, cost),
    prune: (before) => httpCalls.prune(db, before),
    counts: (since, hourAgo) => httpCalls.counts(db, since, hourAgo),
    spent: (host, from) => httpCalls.spent(db, host, from),
  };
}

function memoryCallLog(): CallLog {
  let calls: { host: string; at: number; cost: number }[] = [];
  return {
    record: (host, at, cost) => {
      calls = [...calls, { host, at, cost }];
    },
    prune: (before) => {
      calls = calls.filter((c) => c.at >= before);
    },
    counts: (since, hourAgo) =>
      [...Map.groupBy(calls, (c) => c.host)].map(([host, list]) => ({
        host,
        calls: list.filter((c) => c.at >= since).length,
        lastHour: list.filter((c) => c.at >= hourAgo).length,
      })),
    spent: (host, from) => calls.filter((c) => c.host === host && c.at >= from).reduce((n, c) => n + c.cost, 0),
  };
}

// ---- the client --------------------------------------------------------------------

/**
 * Polite HTTP client for metadata services: identifies itself, keeps each host under its
 * published rate limit (one request at a time, starts spaced out), stops sending to a host
 * that answers 429 until its cooldown is over, retries 5xx with backoff and caches successful
 * and 404 responses in SQLite. Interactive requests go ahead of background (bulk) ones.
 */
export interface HttpClient {
  userAgent(): string;
  /** The contact email the requests carry, if any. */
  readonly contact: string | null;
  /** Run `fn` with its requests queued behind interactive ones (bulk lookups). */
  background<T>(fn: () => Promise<T>): Promise<T>;
  /** Hosts currently cooling down after a 429, with the time they accept requests again. */
  cooldowns(): { host: string; until: number }[];
  /** GET returning text (JSON callers parse). Cached responses are returned without a request. */
  get(url: string, accept?: string, opts?: RequestOptions): Promise<HttpResponse>;
  getJson<T>(url: string, accept?: string, opts?: RequestOptions): Promise<T | null>;
  /** POST of a JSON body, returning text; never cached (callers can `prime` the cache with what they learn). */
  post(url: string, payload: unknown, opts?: RequestOptions): Promise<HttpResponse>;
  /** GET that always asks the service (account and quota details); not cached. */
  getFresh(url: string, opts?: RequestOptions): Promise<HttpResponse>;
  /** Whether a GET of `url` would be answered from the cache. */
  isCached(url: string, accept?: string): boolean;
  /** Store a response for a GET of `url` learned another way (e.g. from a bulk call). */
  prime(url: string, res: HttpResponse, accept?: string): void;
  /** Calls left today under `host`'s daily quota (the lower of our count and the service's own report); null when it has none. */
  quotaLeft(host: string): number | null;
  /** Binary GET (covers); not cached. Returns null for 404. */
  getBytes(url: string, maxBytes?: number): Promise<Uint8Array | null>;
  /**
   * Requests sent per service since `since` and in the last hour, with each service's published
   * limit (for the current identification) and any rate-limit cooldown.
   */
  usage(since: number): MetadataUsageDto;
  /** Calls charged to `host` since 00:00 UTC (by our own count). */
  spentToday(host: string): number;
}

/** `db` null: nothing is cached and calls are counted in memory (tests). */
export function createHttpClient(db: Database | null, contactEmail: () => string | null, options: HttpClientOptions = {}): HttpClient {
  const opts = {
    minIntervalMs: options.minIntervalMs ?? 1000,
    timeoutMs: options.timeoutMs ?? 20_000,
    okTtlMs: options.okTtlMs ?? 7 * DAY,
    notFoundTtlMs: options.notFoundTtlMs ?? DAY,
    retries: options.retries ?? 3,
    maxWaitMs: options.maxWaitMs ?? 10_000,
  };
  const hostLimits: Record<string, HostLimit> = { ...HOST_LIMITS, ...options.hostLimits };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const priority = new AsyncLocalStorage<Priority>();
  const calls = db ? dbCallLog(db) : memoryCallLog();
  const hosts = new Map<string, HostState>();
  let lastPrune = 0;

  const userAgent = () => {
    const email = contactEmail();
    return `Bookshelf/0.1 (self-hosted book manager${email ? `; mailto:${email}` : ""})`;
  };

  const state = (host: string): HostState => {
    const existing = hosts.get(host);
    if (existing) return existing;
    const fresh: HostState = { busy: false, waiters: [], nextStart: 0, blockedUntil: 0, strikes: 0, advertisedMs: 0, reportedDaily: null };
    hosts.set(host, fresh);
    return fresh;
  };

  const interval = (host: string, s: HostState) => paceInterval(hostLimits[host], opts.minIntervalMs, !!contactEmail(), s.advertisedMs);

  const spentToday = (host: string) => calls.spent(host, utcDayStart(now()));

  /** The service's own report of its daily quota, while it still applies. */
  const reportedDaily = (host: string): ReportedQuota | null => {
    const r = hosts.get(host)?.reportedDaily;
    return r && r.resetAt > now() ? r : null;
  };

  const cooldowns = () => {
    const t = now();
    return [...hosts].filter(([, s]) => s.blockedUntil > t).map(([host, s]) => ({ host, until: s.blockedUntil }));
  };

  /** Fails, without sending anything, when `cost` more calls would go past `host`'s daily quota. */
  const checkQuota = (host: string, cost: number) => {
    const limit = hostLimits[host]?.dailyLimit;
    const resetAt = quotaBlockedUntil(cost, limit, limit ? spentToday(host) : 0, reportedDaily(host), now());
    if (resetAt !== null) throw new QuotaExceededError(host, resetAt);
  };

  const recordCall = (host: string, at: number, cost: number) => {
    calls.record(host, at, cost);
    if (at - lastPrune > MINUTE) {
      lastPrune = at;
      calls.prune(at - CALL_RETENTION_MS);
    }
  };

  /**
   * Wait for this host's turn: no other request in flight, the pace interval elapsed and no
   * cooldown. A cooldown longer than `maxWaitMs` fails instead of waiting. Returns the release.
   */
  const acquire = async (host: string): Promise<() => void> => {
    const s = state(host);
    const prio = priority.getStore() ?? "interactive";
    if (s.busy || s.waiters.length) {
      await new Promise<void>((wake) => s.waiters.splice(queuePosition(s.waiters, prio), 0, { priority: prio, wake }));
    }
    s.busy = true; // held from here (the previous holder handed the slot over)
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = s.waiters.shift();
      if (next) next.wake();
      else s.busy = false;
    };
    // Holding the slot, nothing else can move nextStart/blockedUntil: one wait is enough.
    const t = now();
    if (s.blockedUntil > t + opts.maxWaitMs) {
      release();
      throw new RateLimitedError(host, s.blockedUntil, t);
    }
    const wait = Math.max(s.nextStart, s.blockedUntil) - t;
    if (wait > 0) await sleep(wait);
    s.nextStart = now() + interval(host, s);
    return release;
  };

  const request = async (url: string, accept: string, ropts: RequestOptions = {}, body?: string): Promise<Response> => {
    const host = new URL(url).host;
    const cost = ropts.cost ?? 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      const release = await acquire(host);
      try {
        checkQuota(host, cost);
      } catch (err) {
        release();
        throw err;
      }
      const startedAt = now();
      recordCall(host, startedAt, cost);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "User-Agent": userAgent(),
            Accept: accept,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...ropts.headers,
          },
          body,
          redirect: "follow",
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        release();
        lastError = err;
        if (attempt < opts.retries) await sleep(1000 * 2 ** attempt);
        continue;
      }
      const s = state(host);
      const rate = readRateHeaders(res.headers, now());
      if (rate.advertisedMs) {
        // Applies to the very next request, whose start time was set before these headers arrived.
        s.advertisedMs = rate.advertisedMs;
        s.nextStart = Math.max(s.nextStart, startedAt + interval(host, s));
      }
      if (rate.daily) s.reportedDaily = rate.daily;
      if (rate.rateResetAt !== null) s.nextStart = Math.max(s.nextStart, rate.rateResetAt);

      if (res.status === 429 && rate.daily?.left === 0) {
        // The day's quota, not the pace: no cooldown and no retry, the caller falls back to other services.
        await res.body?.cancel();
        release();
        throw new QuotaExceededError(host, rate.daily.resetAt);
      }
      if (res.status === 429 || (res.status === 503 && rate.retryAfterMs !== null)) {
        // Rate limited: every request to this host waits out the cooldown (the next attempt
        // waits for it if it is short, otherwise fails with RateLimitedError).
        await res.body?.cancel();
        s.strikes++;
        s.blockedUntil = Math.max(s.blockedUntil, now() + cooldownMs(rate.retryAfterMs, s.strikes));
        release();
        lastError = new RateLimitedError(host, s.blockedUntil, now());
        continue;
      }
      release();
      if (res.status >= 500) {
        lastError = new HttpError(`${host} answered ${res.status}`, res.status);
        await res.body?.cancel();
        if (attempt < opts.retries) await sleep(1000 * 2 ** attempt);
        continue;
      }
      s.strikes = 0;
      return res;
    }
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(`Could not reach ${host}: ${lastError instanceof Error ? lastError.message : String(lastError)}`, null);
  };

  const readCache = (key: string): HttpResponse | null => {
    const row = db ? httpCache.get(db, key) : null;
    return row && isFresh(row.status, row.fetchedAt, now(), opts) ? { status: row.status, body: row.body } : null;
  };

  const writeCache = (key: string, res: HttpResponse) => {
    if (db) httpCache.put(db, key, { ...res, fetchedAt: new Date(now()).toISOString() });
  };

  const get = async (url: string, accept = "application/json", ropts: RequestOptions = {}): Promise<HttpResponse> => {
    const key = `${accept} ${url}`;
    const cached = readCache(key);
    if (cached) return cached;
    const res = await request(url, accept, ropts);
    const cacheable = res.status === 200 || res.status === 404;
    const out = { status: res.status, body: cacheable ? await res.text() : "" };
    if (cacheable) writeCache(key, out);
    return out;
  };

  return {
    userAgent,
    get contact() {
      return contactEmail();
    },
    background: (fn) => priority.run("background", fn),
    cooldowns,
    get,
    async getJson<T>(url: string, accept = "application/json", ropts: RequestOptions = {}): Promise<T | null> {
      const res = await get(url, accept, ropts);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
      try {
        return JSON.parse(res.body) as T;
      } catch {
        throw new HttpError(`${new URL(url).host} returned invalid JSON`, res.status);
      }
    },
    async post(url, payload, ropts = {}) {
      const res = await request(url, "application/json", ropts, JSON.stringify(payload));
      return { status: res.status, body: await res.text() };
    },
    async getFresh(url, ropts = {}) {
      const res = await request(url, "application/json", ropts);
      return { status: res.status, body: await res.text() };
    },
    isCached: (url, accept = "application/json") => readCache(`${accept} ${url}`) !== null,
    prime: (url, res, accept = "application/json") => writeCache(`${accept} ${url}`, res),
    quotaLeft: (host) => quotaRemaining(hostLimits[host]?.dailyLimit, spentToday(host), reportedDaily(host)),
    async getBytes(url, maxBytes = 20 * 1024 * 1024) {
      const res = await request(url, "image/*", { cost: 0 });
      if (res.status === 404) return null;
      if (res.status !== 200) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.byteLength > maxBytes) throw new HttpError("Image too large", res.status);
      return data;
    },
    usage(since) {
      const t = now();
      const quotaHosts = Object.keys(hostLimits).filter((h) => hostLimits[h]!.dailyLimit);
      return usageSummary({
        now: t,
        identified: !!contactEmail(),
        hostLimits,
        counts: calls.counts(since, t - HOUR),
        cooldowns: new Map(cooldowns().map((c) => [c.host, c.until])),
        spentToday: new Map(quotaHosts.map((h) => [h, spentToday(h)])),
        reported: new Map(
          [...hosts.keys()].flatMap((h) => {
            const r = reportedDaily(h);
            return r ? [[h, r] as const] : [];
          }),
        ),
      });
    },
    spentToday,
  };
}
