import type { Database } from "bun:sqlite";

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpClientOptions {
  /** Minimum delay between request starts to the same host. */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Cache lifetime for successful responses and for 404s. */
  okTtlMs?: number;
  notFoundTtlMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Polite HTTP client for metadata services: identifies itself, throttles per host,
 * retries 429/5xx with backoff and caches successful and 404 responses in SQLite.
 */
export class HttpClient {
  private readonly lastStart = new Map<string, Promise<void>>();
  private readonly opts: Required<Omit<HttpClientOptions, "fetchImpl" | "sleep">>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

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
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  userAgent(): string {
    const email = this.contactEmail();
    return `Bookshelf/0.1 (self-hosted book manager${email ? `; mailto:${email}` : ""})`;
  }

  get contact(): string | null {
    return this.contactEmail();
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
      await this.throttle(host);
      try {
        const res = await this.fetchImpl(url, {
          headers: { "User-Agent": this.userAgent(), Accept: accept },
          redirect: "follow",
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new HttpError(`${host} answered ${res.status}`, res.status);
          const retryAfter = Number(res.headers.get("retry-after"));
          await res.body?.cancel();
          if (attempt < this.opts.retries) await this.sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt < this.opts.retries) await this.sleep(1000 * 2 ** attempt);
      }
    }
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(`Could not reach ${host}: ${lastError instanceof Error ? lastError.message : String(lastError)}`, null);
  }

  /** Space out request starts per host (requests to different hosts run independently). */
  private throttle(host: string): Promise<void> {
    const prev = this.lastStart.get(host) ?? Promise.resolve();
    const next = prev.then(() => this.sleep(this.opts.minIntervalMs));
    this.lastStart.set(host, next);
    return prev;
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
