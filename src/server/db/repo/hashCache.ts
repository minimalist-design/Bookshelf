import type { Database } from "bun:sqlite";

/** Pure cache (path, size, mtime) → hash. Never used to decide which books exist. */

export function get(db: Database, path: string, size: number, mtimeMs: number): string | null {
  const row = db
    .query("SELECT hash FROM file_hash_cache WHERE path = ? AND size = ? AND mtime_ms = ?")
    .get(path, size, Math.trunc(mtimeMs)) as { hash: string } | null;
  return row?.hash ?? null;
}

export function put(db: Database, path: string, size: number, mtimeMs: number, hash: string): void {
  db.query(
    `INSERT INTO file_hash_cache (path, size, mtime_ms, hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash`,
  ).run(path, size, Math.trunc(mtimeMs), hash);
}

/** Move a cache entry after the app renamed a file (content unchanged). */
export function rename(db: Database, from: string, to: string): void {
  db.query("DELETE FROM file_hash_cache WHERE path = ?").run(to);
  db.query("UPDATE file_hash_cache SET path = ? WHERE path = ?").run(to, from);
}

export function remove(db: Database, path: string): void {
  db.query("DELETE FROM file_hash_cache WHERE path = ?").run(path);
}

/** Remove every entry whose path is not in `keep` (absolute paths). */
export function prune(db: Database, keep: ReadonlySet<string>): number {
  const rows = db.query("SELECT path FROM file_hash_cache").all() as { path: string }[];
  const stale = rows.filter((r) => !keep.has(r.path));
  const del = db.query("DELETE FROM file_hash_cache WHERE path = ?");
  db.transaction(() => {
    for (const r of stale) del.run(r.path);
  })();
  return stale.length;
}

export function count(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM file_hash_cache").get() as { n: number }).n;
}
