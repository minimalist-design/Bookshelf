import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { getSettings, updateSettings } from "../src/server/api/settings.ts";
import { validateShelfName, ValidationError } from "../src/server/library/paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "bookshelf-test-"));
const apps: AppContext[] = [];
afterAll(async () => {
  for (const app of apps) await app.library.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeApp(env: Record<string, string> = {}) {
  const dataDir = join(tmp, `data-${Math.random().toString(36).slice(2)}`);
  const app = createApp(loadConfig({ BOOKSHELF_DATA_DIR: dataDir, ...env }));
  apps.push(app);
  return app;
}

describe("database", () => {
  test("migrations create the schema and are idempotent", () => {
    const app = makeApp();
    const tables = app.db.query("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["settings", "books", "book_hashes", "authors", "tags", "books_fts", "file_hash_cache"]) {
      expect(names).toContain(t);
    }
    expect((app.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
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

  test("env override wins and locks the setting", () => {
    const lib = join(tmp, "envlib");
    mkdirSync(lib, { recursive: true });
    const app = makeApp({ BOOKSHELF_LIBRARY_ROOT: lib });
    expect(getSettings(app)).toMatchObject({ libraryRoot: lib, libraryRootFromEnv: true });
    expect(() => updateSettings(app, { libraryRoot: lib })).toThrow(ValidationError);
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
