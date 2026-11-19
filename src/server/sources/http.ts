import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";

export interface HttpResponse {
  status: number;
  body: string;
}

/** Pace for one host: minimum time between request starts (one request in flight at a time). */
export interface HostLimit {
  intervalMs: number;
  /** Faster pace allowed once the requests carry a contact email (Open Library, Crossref polite pool). */
  identifiedIntervalMs?: number;
}

/**
 * Published limits, with a margin (as of 2026):
 * - Open Library: 1 req/s, or 3 req/s with a User-Agent naming a contact.
 * - Covers by cover ID are not rate-limited; stay at 1 req/s anyway.
 * - Crossref: searches 1 req/s public, 3 req/s polite (mailto); single DOIs 5 / 10 req/s.
 *   Crossref also advertises its current limit in X-Rate-Limit-* headers, which tighten the pace.
 * - doi.org content negotiation: no published limit; 1 req/s.
 */
export const HOST_LIMITS: Readonly<Record<string, HostLimit>> = {
  "openlibrary.org": { intervalMs: 1100, identifiedIntervalMs: 500 },
  "covers.openlibrary.org": { intervalMs: 1000 },
  "api.crossref.org": { intervalMs: 1100, identifiedIntervalMs: 500 },
  "doi.org": { intervalMs: 1000 },
};

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

/** A service asked us to slow down; no request is sent to `host` before `retryAt` (epoch ms). */
export class RateLimitedError extends HttpError {
  constructor(readonly host: string, readonly retryAt: number, now: number) {
    super(`${host} asked us to slow down; try again in ${formatWait(retryAt - now)}`, 429);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
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

type Priority = "interactive" | "background";

/** Per-host state: one request at a time, starts spaced out, cooldown after a 429. */
interface HostState {
  busy: boolean;
  waiters: { priority: Priority; wake: () => void }[];
  nextStart: number;
  blockedUntil: number;
  strikes: number;
  advertisedMs: number;
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
  async get(url: string, accept = "application/json"): Promise<HttpResponse> {
    const key = `${accept} ${url}`;
    const cached = this.readCache(key);
    if (cached) return cached;

    const res = await this.request(url, accept);
    const body = res.status === 200 || res.status === 404 ? await res.text() : "";
    const out = { status: res.status, body };
    if (res.status === 200 || res.status === 404) this.writeCache(key, out);
    return out;
  }

  async getJson<T>(url: string, accept = "application/json"): Promise<T | null> {
    const res = await this.get(url, accept);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new HttpError(`${new URL(url).host} returned invalid JSON`, res.status);
    }
  }

  /** Binary GET (covers); not cached. Returns null for 404. */
  async getBytes(url: string, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array | null> {
    const res = await this.request(url, "image/*");
    if (res.status === 404) return null;
    if (res.status !== 200) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) throw new HttpError("Image too large", res.status);
    return data;
  }

  private async request(url: string, accept: string): Promise<Response> {
    const host = new URL(url).host;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      const release = await this.acquire(host);
      const startedAt = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { "User-Agent": this.userAgent(), Accept: accept },
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
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"), this.now());

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

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) this.hosts.set(host, (s = { busy: false, waiters: [], nextStart: 0, blockedUntil: 0, strikes: 0, advertisedMs: 0 }));
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
