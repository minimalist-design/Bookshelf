import type { Database } from "bun:sqlite";
import m001 from "./migrations/001_init.sql" with { type: "text" };
import m002 from "./migrations/002_review_queue.sql" with { type: "text" };
import m003 from "./migrations/003_edition.sql" with { type: "text" };
import m004 from "./migrations/004_lookup_jobs.sql" with { type: "text" };
import m005 from "./migrations/005_http_calls.sql" with { type: "text" };
import m006 from "./migrations/006_aliases.sql" with { type: "text" };
import m007 from "./migrations/007_http_call_cost.sql" with { type: "text" };
import m008 from "./migrations/008_isbndb_records.sql" with { type: "text" };
import m009 from "./migrations/009_isbndb_covers.sql" with { type: "text" };

/** Ordered list of migrations; append new ones, never edit applied ones. */
const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  { version: 1, name: "init", sql: m001 },
  { version: 2, name: "review_queue", sql: m002 },
  { version: 3, name: "edition", sql: m003 },
  { version: 4, name: "lookup_jobs", sql: m004 },
  { version: 5, name: "http_calls", sql: m005 },
  { version: 6, name: "aliases", sql: m006 },
  { version: 7, name: "http_call_cost", sql: m007 },
  { version: 8, name: "isbndb_records", sql: m008 },
  { version: 9, name: "isbndb_covers", sql: m009 },
];

export function migrate(db: Database): number {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
    applied++;
  }
  return applied;
}
