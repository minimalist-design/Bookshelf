import type { Database } from "bun:sqlite";
import m001 from "./migrations/001_init.sql" with { type: "text" };
import m002 from "./migrations/002_review_queue.sql" with { type: "text" };

/** Ordered list of migrations; append new ones, never edit applied ones. */
const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  { version: 1, name: "init", sql: m001 },
  { version: 2, name: "review_queue", sql: m002 },
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
