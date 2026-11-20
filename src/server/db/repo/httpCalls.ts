import type { Database } from "bun:sqlite";

/** Requests sent to the metadata services (for pacing summaries and daily quotas). Times are epoch ms. */

export function record(db: Database, host: string, at: number, cost: number): void {
  db.query("INSERT INTO http_calls (host, at, cost) VALUES (?, ?, ?)").run(host, at, cost);
}

/** Forget calls made before `before`. */
export function prune(db: Database, before: number): void {
  db.query("DELETE FROM http_calls WHERE at < ?").run(before);
}

/** Calls per host since `since` and since `hourAgo`. */
export function counts(db: Database, since: number, hourAgo: number): { host: string; calls: number; lastHour: number }[] {
  const rows = db
    .query("SELECT host, SUM(at >= ?) AS calls, SUM(at >= ?) AS lastHour FROM http_calls WHERE at >= ? GROUP BY host")
    .all(since, hourAgo, Math.min(since, hourAgo)) as { host: string; calls: number | null; lastHour: number | null }[];
  return rows.map((r) => ({ host: r.host, calls: r.calls ?? 0, lastHour: r.lastHour ?? 0 }));
}

/** Quota charged to `host` since `from`. */
export function spent(db: Database, host: string, from: number): number {
  return (db.query("SELECT COALESCE(SUM(cost), 0) AS n FROM http_calls WHERE host = ? AND at >= ?").get(host, from) as { n: number }).n;
}
