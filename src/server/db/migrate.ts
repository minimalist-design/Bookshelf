import type { Database } from "bun:sqlite";
import m001 from "./migrations/001_init.sql" with { type: "text" };

/** Ordered list of migrations; append new ones, never edit applied ones. */
const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [{ version: 1, name: "init", sql: m001 }];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

/** A database whose schema this program doesn't know (an older Bookshelf's, from before the schema was reset). */
export class UnknownSchemaError extends Error {}

export function migrate(db: Database): number {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new UnknownSchemaError(
      `The database has schema version ${current}, which this Bookshelf doesn't know (its newest is ${SCHEMA_VERSION}). ` +
        "It was made by an older Bookshelf whose schema has since been reset: delete the data directory and start again.",
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
  }
  return pending.length;
}
