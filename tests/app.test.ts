import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { getSettings, prepareEnvLibraryRoot, updateSettings } from "../src/server/api/settings.ts";
import { browseDirectories, makeDirectory } from "../src/server/api/fsBrowse.ts";
import { ConflictError, NotFoundError } from "../src/server/api/http.ts";
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
    expect((app.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
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

  test("a missing env library root is created only the first time", () => {
    const lib = join(tmp, "envcreated", "lib");
    const app = makeApp({ BOOKSHELF_LIBRARY_ROOT: lib });
    prepareEnvLibraryRoot(app);
    expect(existsSync(lib)).toBe(true);
    rmSync(lib, { recursive: true });
    prepareEnvLibraryRoot(app); // e.g. drive unmounted later: leave it missing
    expect(existsSync(lib)).toBe(false);
  });

  test("env override wins and locks the setting", () => {
    const lib = join(tmp, "envlib");
    mkdirSync(lib, { recursive: true });
    const app = makeApp({ BOOKSHELF_LIBRARY_ROOT: lib });
    expect(getSettings(app)).toMatchObject({ libraryRoot: lib, libraryRootFromEnv: true });
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

describe("directory browser", () => {
  test("missing directory is a 404", () => {
    expect(() => browseDirectories(join(tmp, "nope"))).toThrow(NotFoundError);
  });

  test("create a folder", () => {
    const parent = join(tmp, "mkdir-parent");
    mkdirSync(parent, { recursive: true });
    const { path } = makeDirectory(parent, " Books ");
    expect(path).toBe(join(parent, "Books"));
    expect(browseDirectories(parent).dirs.map((d) => d.name)).toEqual(["Books"]);
    expect(() => makeDirectory(parent, "Books")).toThrow(ConflictError);
    for (const bad of ["", "..", "../x", "a/b", ".hidden"]) expect(() => makeDirectory(parent, bad)).toThrow(ValidationError);
    expect(() => makeDirectory(join(tmp, "nope"), "x")).toThrow(NotFoundError);
    writeFileSync(join(parent, "file"), "");
    expect(() => makeDirectory(join(parent, "file"), "x")).toThrow(ValidationError);
  });
});
