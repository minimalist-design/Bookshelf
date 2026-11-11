import type { Database } from "bun:sqlite";

/** Pure cache (path, size, mtime) → hash. Never used to decide which books exist. */
export class HashCacheRepo {
  constructor(private readonly db: Database) {}

  get(path: string, size: number, mtimeMs: number): string | null {
    const row = this.db
      .query("SELECT hash FROM file_hash_cache WHERE path = ? AND size = ? AND mtime_ms = ?")
      .get(path, size, Math.trunc(mtimeMs)) as { hash: string } | null;
    return row?.hash ?? null;
  }

  put(path: string, size: number, mtimeMs: number, hash: string): void {
    this.db
      .query(
        `INSERT INTO file_hash_cache (path, size, mtime_ms, hash) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash`,
      )
      .run(path, size, Math.trunc(mtimeMs), hash);
  }

  /** Move a cache entry after the app renamed a file (content unchanged). */
  rename(from: string, to: string): void {
    this.db.query("DELETE FROM file_hash_cache WHERE path = ?").run(to);
    this.db.query("UPDATE file_hash_cache SET path = ? WHERE path = ?").run(to, from);
  }

  delete(path: string): void {
    this.db.query("DELETE FROM file_hash_cache WHERE path = ?").run(path);
  }

  /** Remove every entry whose path is not in `keep` (absolute paths). */
  prune(keep: ReadonlySet<string>): number {
    const rows = this.db.query("SELECT path FROM file_hash_cache").all() as { path: string }[];
    const stale = rows.filter((r) => !keep.has(r.path));
    const del = this.db.query("DELETE FROM file_hash_cache WHERE path = ?");
    this.db.transaction(() => stale.forEach((r) => del.run(r.path)))();
    return stale.length;
  }
}
