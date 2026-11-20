import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { migrate, UnknownSchemaError } from "./migrate.ts";

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (err) {
    db.close();
    if (err instanceof UnknownSchemaError) throw new UnknownSchemaError(`${err.message} (database: ${path}; data directory: ${dirname(path)})`);
    throw err;
  }
  return db;
}
