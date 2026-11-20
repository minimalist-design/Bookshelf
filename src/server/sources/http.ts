import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import type { MetadataUsageDto } from "../../shared/types.ts";

export interface HttpResponse {
  status: number;
  body: string;
}

/** Pace for one host: minimum time between request starts (one request in flight at a time). */
export interface HostLimit {
  /** Service name shown to the user. */
  name?: string;
  intervalMs: number;
  /** Faster pace allowed once the requests carry a contact email (Open Library, Crossref polite pool). */
  identifiedIntervalMs?: number;
  /** Published limit in requests per second (display only; null = none published). */
  perSecond?: number | null;
  identifiedPerSecond?: number;
  /** Calls allowed per UTC day (ISBNdb); requests beyond it fail with QuotaExceededError instead of being sent. */
  dailyLimit?: number;
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
  headers?: Record<string, string>;
  /** Daily-quota calls this request is charged (default 1; an ISBNdb bulk call costs one per ISBN). */
  cost?: number;
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

/** Per-host state: one request at a time, starts spaced out, cooldown after a 429. */
interface HostState {
  busy: boolean;
  waiters: { priority: Priority; wake: () => void }[];
  nextStart: number;
  blockedUntil: number;
  strikes: number;
  advertisedMs: number;
  /** What the service last reported as left of its daily quota. */
  reportedDaily: { left: number; resetAt: number } | null;
}

/**
 * Polite HTTP client for metadata services: identifies itself, keeps each host under its
 * published rate limit (one request at a time, starts spaced out), stops sending to a host
 * that answers 429 until its cooldown is over, retries 5xx with backoff and caches successful
 * and 404 responses in SQLite. Interactive requests go ahead of background (bulk) ones.
 */
export class HttpClient {
  private readonly hosts = new Map<string, HostState>();
  private readonly opts: Required<Omit<HttpClientOptions, "fetchImpl" | "sleep" | "now" | "hostLimits">>;
  private readonly hostLimits: Record<string, HostLimit>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly priority = new AsyncLocalStorage<Priority>();
  /** Call records when there is no database (tests). */
  private readonly memoryCalls: { host: string; at: number; cost: number }[] = [];
  private lastPrune = 0;

  constructor(
    private readonly db: Database | null,
    private readonly contactEmail: () => string | null,
    options: HttpClientOptions = {},
  ) {
    this.opts = {
      minIntervalMs: options.minIntervalMs ?? 1000,
      timeoutMs: options.timeoutMs ?? 20_000,
      okTtlMs: options.okTtlMs ?? 7 * DAY,
      notFoundTtlMs: options.notFoundTtlMs ?? DAY,
      retries: options.retries ?? 3,
      maxWaitMs: options.maxWaitMs ?? 10_000,
    };
    this.hostLimits = { ...HOST_LIMITS, ...options.hostLimits };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = options.now ?? Date.now;
  }

  userAgent(): string {
    const email = this.contactEmail();
    return `Bookshelf/0.1 (self-hosted book manager${email ? `; mailto:${email}` : ""})`;
  }

  get contact(): string | null {
    return this.contactEmail();
  }

  /** Run `fn` with its requests queued behind interactive ones (bulk lookups). */
  background<T>(fn: () => Promise<T>): Promise<T> {
    return this.priority.run("background", fn);
  }

  /** Hosts currently cooling down after a 429, with the time they accept requests again. */
  cooldowns(): { host: string; until: number }[] {
    const now = this.now();
    return [...this.hosts].filter(([, s]) => s.blockedUntil > now).map(([host, s]) => ({ host, until: s.blockedUntil }));
  }

  /** GET returning text (JSON callers parse). Cached responses are returned without a request. */
  async get(url: string, accept = "application/json", opts: RequestOptions = {}): Promise<HttpResponse> {
    const key = `${accept} ${url}`;
    const cached = this.readCache(key);
    if (cached) return cached;

    const res = await this.request(url, accept, opts);
    const body = res.status === 200 || res.status === 404 ? await res.text() : "";
    const out = { status: res.status, body };
    if (res.status === 200 || res.status === 404) this.writeCache(key, out);
    return out;
  }

  async getJson<T>(url: string, accept = "application/json", opts: RequestOptions = {}): Promise<T | null> {
    const res = await this.get(url, accept, opts);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new HttpError(`${new URL(url).host} returned invalid JSON`, res.status);
    }
  }

  /** POST of a JSON body, returning text; never cached (callers can `prime` the cache with what they learn). */
  async post(url: string, payload: unknown, opts: RequestOptions = {}): Promise<HttpResponse> {
    const res = await this.request(url, "application/json", opts, JSON.stringify(payload));
    return { status: res.status, body: await res.text() };
  }

  /** GET that always asks the service (account and quota details); not cached. */
  async getFresh(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const res = await this.request(url, "application/json", opts);
    return { status: res.status, body: await res.text() };
  }

  /** Whether a GET of `url` would be answered from the cache. */
  isCached(url: string, accept = "application/json"): boolean {
    return this.readCache(`${accept} ${url}`) !== null;
  }

  /** Store a response for a GET of `url` learned another way (e.g. from a bulk call). */
  prime(url: string, res: HttpResponse, accept = "application/json"): void {
    this.writeCache(`${accept} ${url}`, res);
  }

  /** Calls left today under `host`'s daily quota (the lower of our count and the service's own report); null when it has none. */
  quotaLeft(host: string): number | null {
    const limit = this.hostLimits[host]?.dailyLimit;
    const reported = this.reportedDaily(host);
    const own = limit ? Math.max(0, limit - this.spentToday(host)) : null;
    if (own === null) return reported?.left ?? null;
    return reported ? Math.min(own, reported.left) : own;
  }

  /** Binary GET (covers); not cached. Returns null for 404. */
  async getBytes(url: string, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array | null> {
    const res = await this.request(url, "image/*", { cost: 0 });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) throw new HttpError("Image too large", res.status);
    return data;
  }

  private async request(url: string, accept: string, opts: RequestOptions = {}, body?: string): Promise<Response> {
    const host = new URL(url).host;
    const cost = opts.cost ?? 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      const release = await this.acquire(host);
      try {
        this.checkQuota(host, cost);
      } catch (err) {
        release();
        throw err;
      }
      const startedAt = this.now();
      this.recordCall(host, startedAt, cost);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "User-Agent": this.userAgent(),
            Accept: accept,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...opts.headers,
          },
          body,
          redirect: "follow",
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        release();
        lastError = err;
        if (attempt < this.opts.retries) await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const state = this.state(host);
      const advertised = advertisedInterval(res.headers);
      if (advertised) {
        // Applies to the very next request, whose start time was set before these headers arrived.
        state.advertisedMs = advertised;
        state.nextStart = Math.max(state.nextStart, startedAt + this.interval(host, state));
      }
      const limits = parseRateLimit(res.headers.get("ratelimit"));
      const daily = limits.get("daily");
      if (daily) state.reportedDaily = { left: daily.left, resetAt: this.now() + daily.resetSeconds * 1000 };
      const rate = limits.get("rate");
      // The window is spent: the next request waits for it to reset.
      if (rate && rate.left === 0) state.nextStart = Math.max(state.nextStart, this.now() + rate.resetSeconds * 1000);
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"), this.now()) ?? (rate && rate.left === 0 ? rate.resetSeconds * 1000 : null);

      if (res.status === 429 && daily && daily.left === 0) {
        // The day's quota, not the pace: no cooldown and no retry, the caller falls back to other services.
        await res.body?.cancel();
        release();
        throw new QuotaExceededError(host, state.reportedDaily!.resetAt);
      }
      if (res.status === 429 || (res.status === 503 && retryAfter !== null)) {
        // Rate limited: every request to this host waits out the cooldown (the next attempt
        // waits for it if it is short, otherwise fails with RateLimitedError).
        await res.body?.cancel();
        state.strikes++;
        const cooldown = retryAfter !== null
          ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
          : Math.min(BASE_COOLDOWN_MS * 2 ** (state.strikes - 1), MAX_COOLDOWN_MS);
        state.blockedUntil = Math.max(state.blockedUntil, this.now() + cooldown);
        release();
        lastError = new RateLimitedError(host, state.blockedUntil, this.now());
        continue;
      }
      release();
      if (res.status >= 500) {
        lastError = new HttpError(`${host} answered ${res.status}`, res.status);
        await res.body?.cancel();
        if (attempt < this.opts.retries) await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      state.strikes = 0;
      return res;
    }
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(`Could not reach ${host}: ${lastError instanceof Error ? lastError.message : String(lastError)}`, null);
  }

  /**
   * Requests sent per service since `since` and in the last hour, with each service's published
   * limit (for the current identification) and any rate-limit cooldown.
   */
  usage(since: number): MetadataUsageDto {
    const now = this.now();
    const hourAgo = now - HOUR;
    const dayStart = utcDayStart(now);
    const counts = new Map<string, { calls: number; lastHour: number }>();
    for (const host of Object.keys(this.hostLimits)) counts.set(host, { calls: 0, lastHour: 0 });
    const rows = this.db
      ? (this.db
          .query("SELECT host, SUM(at >= ?) AS calls, SUM(at >= ?) AS lastHour FROM http_calls WHERE at >= ? GROUP BY host")
          .all(since, hourAgo, Math.min(since, hourAgo)) as { host: string; calls: number; lastHour: number }[])
      : [...Map.groupBy(this.memoryCalls, (c) => c.host)].map(([host, list]) => ({
          host,
          calls: list.filter((c) => c.at >= since).length,
          lastHour: list.filter((c) => c.at >= hourAgo).length,
        }));
    for (const r of rows) counts.set(r.host, { calls: r.calls ?? 0, lastHour: r.lastHour ?? 0 });

    const identified = !!this.contactEmail();
    const cooldowns = new Map(this.cooldowns().map((c) => [c.host, c.until]));
    return {
      now,
      identified,
      services: [...counts].map(([host, c]) => {
        const limit = this.hostLimits[host];
        const perSecond = (identified && limit?.identifiedPerSecond) || limit?.perSecond || null;
        const until = cooldowns.get(host);
        const dailyLimit = limit?.dailyLimit ?? null;
        const reported = this.reportedDaily(host);
        return {
          host,
          name: serviceName(host),
          calls: c.calls,
          lastHour: c.lastHour,
          perSecond,
          hourLimit: perSecond ? perSecond * 3600 : null,
          coolingDownUntil: until ? new Date(until).toISOString() : null,
          dailyLimit,
          today: dailyLimit ? this.spentToday(host) : 0,
          reportedLeft: reported?.left ?? null,
          quotaResetsAt: dailyLimit ? new Date(dayStart + DAY).toISOString() : null,
        };
      }),
    };
  }

  /** Calls charged to `host` since 00:00 UTC (by our own count). */
  spentToday(host: string): number {
    const from = utcDayStart(this.now());
    if (!this.db) return this.memoryCalls.filter((c) => c.host === host && c.at >= from).reduce((n, c) => n + c.cost, 0);
    const row = this.db.query("SELECT COALESCE(SUM(cost), 0) AS n FROM http_calls WHERE host = ? AND at >= ?").get(host, from) as { n: number };
    return row.n;
  }

  /** The service's own report of its daily quota, while it still applies. */
  private reportedDaily(host: string): { left: number; resetAt: number } | null {
    const r = this.hosts.get(host)?.reportedDaily;
    return r && r.resetAt > this.now() ? r : null;
  }

  /** Fails, without sending anything, when `cost` more calls would go past `host`'s daily quota. */
  private checkQuota(host: string, cost: number): void {
    if (cost <= 0) return;
    const limit = this.hostLimits[host]?.dailyLimit;
    if (limit && this.spentToday(host) + cost > limit) throw new QuotaExceededError(host, utcDayStart(this.now()) + DAY);
    const reported = this.reportedDaily(host);
    if (reported && reported.left < cost) throw new QuotaExceededError(host, reported.resetAt);
  }

  private recordCall(host: string, at: number, cost = 1): void {
    const cutoff = at - CALL_RETENTION_MS;
    const prune = at - this.lastPrune > MINUTE;
    if (prune) this.lastPrune = at;
    if (!this.db) {
      this.memoryCalls.push({ host, at, cost });
      if (prune) {
        const keepFrom = this.memoryCalls.findIndex((c) => c.at >= cutoff);
        this.memoryCalls.splice(0, keepFrom === -1 ? this.memoryCalls.length : keepFrom);
      }
      return;
    }
    this.db.query("INSERT INTO http_calls (host, at, cost) VALUES (?, ?, ?)").run(host, at, cost);
    if (prune) this.db.query("DELETE FROM http_calls WHERE at < ?").run(cutoff);
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) this.hosts.set(host, (s = { busy: false, waiters: [], nextStart: 0, blockedUntil: 0, strikes: 0, advertisedMs: 0, reportedDaily: null }));
    return s;
  }

  private interval(host: string, state: HostState): number {
    const limit = this.hostLimits[host];
    const base = !limit
      ? this.opts.minIntervalMs
      : this.contactEmail() && limit.identifiedIntervalMs
        ? limit.identifiedIntervalMs
        : limit.intervalMs;
    return Math.max(base, state.advertisedMs);
  }

  /**
   * Wait for this host's turn: no other request in flight, the pace interval elapsed and no
   * cooldown. A cooldown longer than `maxWaitMs` fails instead of waiting. Returns the release.
   */
  private async acquire(host: string): Promise<() => void> {
    const state = this.state(host);
    const priority = this.priority.getStore() ?? "interactive";
    if (state.busy || state.waiters.length) {
      await new Promise<void>((wake) => {
        const entry = { priority, wake };
        // Interactive requests go before queued background ones.
        const i = priority === "interactive" ? state.waiters.findIndex((w) => w.priority === "background") : -1;
        if (i < 0) state.waiters.push(entry);
        else state.waiters.splice(i, 0, entry);
      });
    }
    state.busy = true; // held from here (the previous holder handed the slot over)
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) next.wake();
      else state.busy = false;
    };
    // Holding the slot, nothing else can move nextStart/blockedUntil: one wait is enough.
    const now = this.now();
    if (state.blockedUntil > now + this.opts.maxWaitMs) {
      release();
      throw new RateLimitedError(host, state.blockedUntil, now);
    }
    const wait = Math.max(state.nextStart, state.blockedUntil) - now;
    if (wait > 0) await this.sleep(wait);
    state.nextStart = this.now() + this.interval(host, state);
    return release;
  }

  private readCache(key: string): HttpResponse | null {
    if (!this.db) return null;
    const row = this.db.query("SELECT status, body, fetched_at FROM http_cache WHERE url = ?").get(key) as
      | { status: number; body: string; fetched_at: string }
      | null;
    if (!row) return null;
    const ttl = row.status === 200 ? this.opts.okTtlMs : this.opts.notFoundTtlMs;
    if (Date.now() - Date.parse(row.fetched_at) > ttl) return null;
    return { status: row.status, body: row.body };
  }

  private writeCache(key: string, res: HttpResponse): void {
    this.db
      ?.query(
        `INSERT INTO http_cache (url, status, body, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`,
      )
      .run(key, res.status, res.body, new Date().toISOString());
  }
}
