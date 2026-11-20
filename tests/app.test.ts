import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppContext } from "../src/server/app.ts";
import { migrate, SCHEMA_VERSION, UnknownSchemaError } from "../src/server/db/migrate.ts";
import { openDatabase } from "../src/server/db/index.ts";
import { loadConfig } from "../src/server/config.ts";
import type { ConfigFileSettings } from "../src/server/configFile.ts";
import { getSettings, prepareConfigLibraryRoot, updateSettings } from "../src/server/api/settings.ts";
import { health } from "../src/server/api/health.ts";
import { validateShelfName, ValidationError } from "../src/server/library/paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "bookshelf-test-"));
const apps: AppContext[] = [];
afterAll(async () => {
  for (const app of apps) await app.library.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeApp(file: ConfigFileSettings = {}) {
  const dataDir = join(tmp, `data-${Math.random().toString(36).slice(2)}`);
  const app = createApp(loadConfig({ data_dir: dataDir, ...file }));
  apps.push(app);
  return app;
}

describe("database", () => {
  test("migrations create the schema and are idempotent", () => {
    const app = makeApp();
    const tables = app.db.query("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["settings", "books", "book_hashes", "authors", "tags", "books_fts", "file_hash_cache", "http_cache", "review_queue", "lookup_jobs", "http_calls", "aliases", "isbndb_records"]) {
      expect(names).toContain(t);
    }
    expect((app.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(migrate(app.db)).toBe(0);
  });

  /**
   * Databases live outside this machine too, already migrated: a migration, once written, is never
   * edited (they run by number, so an edit never reaches them). Change the schema with a new one.
   */
  test("migrations are append-only: every existing file is exactly as first written", () => {
    const dir = join(import.meta.dir, "../src/server/db/migrations");
    const sums = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex").slice(0, 16)]),
    );
    // Add a line for each new migration; never change one.
    expect(sums).toEqual({
      "001_init.sql": "0434772728296ab2",
    });
  });

  test("a database from before the schema reset is refused, untouched", () => {
    const path = join(tmp, "old.db");
    const db = new Database(path);
    db.exec("CREATE TABLE books (id INTEGER PRIMARY KEY); PRAGMA user_version = 9");
    db.close();
    expect(() => openDatabase(path)).toThrow(UnknownSchemaError);
    expect(() => openDatabase(path)).toThrow(/delete the data directory.*data directory: /s);
    const after = new Database(path);
    expect((after.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(9);
    after.close();
  });
});

describe("health", () => {
  test("answers 200 while the database works", async () => {
    const res = health(makeApp());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("answers 503 when the database is unavailable", async () => {
    const app = makeApp();
    await app.library.close();
    app.db.close();
    const res = health(app);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).ok).toBe(false);
  });
});

describe("settings", () => {
  test("library root is validated and stored", () => {
    const app = makeApp();
    const lib = join(tmp, "lib");
    mkdirSync(lib, { recursive: true });
    expect(getSettings(app).libraryRoot).toBeNull();
    expect(updateSettings(app, { libraryRoot: lib }).libraryRoot).toBe(lib);
    expect(() => updateSettings(app, { libraryRoot: join(tmp, "missing") })).toThrow(ValidationError);
    expect(() => updateSettings(app, { libraryRoot: "relative/path" })).toThrow(ValidationError);
    expect(() => updateSettings(app, { libraryRoot: tmp })).toThrow(/data directory/); // data dir inside root
    expect(() => updateSettings(app, { libraryRoot: app.config.dataDir })).toThrow(ValidationError);
  });

  test("setup can create a missing library root", () => {
    const app = makeApp();
    const lib = join(tmp, "created", "nested", "lib");
    expect(() => updateSettings(app, { libraryRoot: lib })).toThrow(ValidationError);
    expect(existsSync(lib)).toBe(false);
    expect(updateSettings(app, { libraryRoot: lib, createLibraryRoot: true }).libraryRoot).toBe(lib);
    expect(existsSync(lib)).toBe(true);
    // Placement rules are checked before creating anything.
    const insideData = join(app.config.dataDir, "lib");
    expect(() => updateSettings(app, { libraryRoot: insideData, createLibraryRoot: true })).toThrow(/data directory/);
    expect(existsSync(insideData)).toBe(false);
    expect(() => updateSettings(app, { libraryRoot: "relative/x", createLibraryRoot: true })).toThrow(ValidationError);
  });

  test("a missing config library root is created only the first time", () => {
    const lib = join(tmp, "envcreated", "lib");
    const app = makeApp({ library_root: lib });
    prepareConfigLibraryRoot(app);
    expect(existsSync(lib)).toBe(true);
    rmSync(lib, { recursive: true });
    prepareConfigLibraryRoot(app); // e.g. drive unmounted later: leave it missing
    expect(existsSync(lib)).toBe(false);
  });

  test("the config file's library root wins and locks the setting", () => {
    const lib = join(tmp, "envlib");
    mkdirSync(lib, { recursive: true });
    const app = makeApp({ library_root: lib });
    expect(getSettings(app)).toMatchObject({ libraryRoot: lib, libraryRootFromConfig: true });
    expect(() => updateSettings(app, { libraryRoot: lib })).toThrow(ValidationError);
    expect(() => updateSettings(app, { libraryRoot: null })).toThrow(ValidationError);
  });

  test("removing the library root unlinks it without touching the disk", async () => {
    const app = makeApp();
    const lib = join(tmp, "removable");
    mkdirSync(join(lib, "Shelf"), { recursive: true });
    writeFileSync(join(lib, "Shelf", "book.epub"), "x");
    updateSettings(app, { libraryRoot: lib });
    expect(updateSettings(app, { libraryRoot: null }).libraryRoot).toBeNull();
    expect(app.settings.get("libraryRoot")).toBeNull();
    await app.library.whenReady();
    expect(app.library.status()).toMatchObject({ state: "no-root", root: null, fileCount: 0, watching: false });
    expect(existsSync(join(lib, "Shelf", "book.epub"))).toBe(true);
  });

  test("contact email", () => {
    const app = makeApp();
    expect(updateSettings(app, { contactEmail: " me@example.org " }).contactEmail).toBe("me@example.org");
    expect(updateSettings(app, { contactEmail: "" }).contactEmail).toBeNull();
    expect(() => updateSettings(app, { contactEmail: "nope" })).toThrow(ValidationError);
  });
});

describe("shelf names", () => {
  test("validation", () => {
    expect(validateShelfName("  Science Fiction ")).toBe("Science Fiction");
    for (const bad of ["", "..", ".hidden", "a/b", "a\\b"]) expect(() => validateShelfName(bad)).toThrow(ValidationError);
  });
});
