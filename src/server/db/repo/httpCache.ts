import type { Database } from "bun:sqlite";

/** Cached HTTP answers of the metadata services (see sources/http.ts). */

export function count(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM http_cache").get() as { n: number }).n;
}

/** Drop every cached answer; returns how many there were. */
export function clear(db: Database): number {
  return db.query("DELETE FROM http_cache").run().changes;
}

export interface CachedResponse {
  readonly status: number;
  readonly body: string;
  /** ISO timestamp. */
  readonly fetchedAt: string;
}

export function get(db: Database, key: string): CachedResponse | null {
  const row = db.query("SELECT status, body, fetched_at FROM http_cache WHERE url = ?").get(key) as
    | { status: number; body: string; fetched_at: string }
    | null;
  return row && { status: row.status, body: row.body, fetchedAt: row.fetched_at };
}

export function put(db: Database, key: string, res: CachedResponse): void {
  db.query(
    `INSERT INTO http_cache (url, status, body, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`,
  ).run(key, res.status, res.body, res.fetchedAt);
}
