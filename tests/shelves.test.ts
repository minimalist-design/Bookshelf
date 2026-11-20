import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConflictError, NotFoundError } from "../src/server/api/http.ts";
import { apiRoutes } from "../src/server/api/router.ts";
import type { AppContext } from "../src/server/app.ts";
import { ValidationError } from "../src/server/library/paths.ts";
import { listLibrary, listShelves } from "../src/server/library/queries.ts";
import { closeTestApp, FAST_LIBRARY, makeEpub, makePng, scratchDir, testApp } from "./fixtures.ts";
import * as bookRepo from "../src/server/db/repo/books.ts";
import * as coverStore from "../src/server/covers/store.ts";
import * as hashCacheRepo from "../src/server/db/repo/hashCache.ts";
import * as books from "../src/server/services/books.ts";
import * as shelves from "../src/server/services/shelves.ts";

let tmp: string;
let root: string;
let app: AppContext;

beforeEach(() => {
  ({ tmp, root } = scratchDir("shelves"));
  app = testApp(tmp);
});

afterEach(() => closeTestApp(app, tmp));

function put(rel: string, content: string | Uint8Array = rel) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
const idOf = (rel: string) => app.library.index.get(rel)!.bookId;
const paths = () => [...app.library.index.allFiles()].map((f) => f.relPath).sort();
const shelfNames = () => listShelves(root, app.library.index).map((s) => s.name);
/** Let watcher events and grace timers run, then check nothing was re-processed or lost. */
async function settle() {
  await Bun.sleep(FAST_LIBRARY.graceMs + 400);
}

describe("shelves", () => {
  test("create: validation and duplicates", async () => {
    await app.library.open(root);
    expect(await shelves.create(app, "  Science Fiction ")).toBe("Science Fiction");
    expect(statSync(join(root, "Science Fiction")).isDirectory()).toBe(true);
    await expect(shelves.create(app, "Science Fiction")).rejects.toThrow(ConflictError);
    await expect(shelves.create(app, "../x")).rejects.toThrow(ValidationError);
    await expect(shelves.create(app, ".hidden")).rejects.toThrow(ValidationError);
    expect(shelfNames()).toEqual([null, "Science Fiction"]);
  });

  test("rename keeps every book, moves the hash cache, watcher stays quiet", async () => {
    put("Old/One -- A.epub");
    put("Old/Sub/Two -- B.epub");
    put("Other/Three -- C.epub");
    await app.library.open(root);
    const one = idOf("Old/One -- A.epub");
    const two = idOf("Old/Sub/Two -- B.epub");

    await expect(shelves.rename(app, "Old", "Other")).rejects.toThrow(ConflictError);
    await expect(shelves.rename(app, "Missing", "X")).rejects.toThrow(NotFoundError);
    expect(await shelves.rename(app, "Old", "New Name")).toBe("New Name");
    expect(paths()).toEqual(["New Name/One -- A.epub", "New Name/Sub/Two -- B.epub", "Other/Three -- C.epub"]);
    expect(idOf("New Name/One -- A.epub")).toBe(one);
    expect(idOf("New Name/Sub/Two -- B.epub")).toBe(two);
    const st = statSync(join(root, "New Name/One -- A.epub"));
    expect(hashCacheRepo.get(app.db, join(root, "New Name/One -- A.epub"), st.size, st.mtimeMs)).toBe(app.library.index.get("New Name/One -- A.epub")!.hash);

    await settle();
    expect(paths()).toHaveLength(3);
    expect(bookRepo.count(app.db)).toBe(3);

    expect(await shelves.rename(app, "New Name", "new name")).toBe("new name"); // case-only rename
    expect(shelfNames()).toEqual([null, "new name", "Other"]);
  });

  test("delete moves books (also nested) to the root, resolves collisions, discards OS junk", async () => {
    put("Same -- Name.epub", "root copy (different content)");
    put("Doomed/Same -- Name.epub", "shelf copy");
    put("Doomed/deep/er/Nested -- Book.epub");
    put("Doomed/.DS_Store", "junk");
    put("Doomed/deep/Thumbs.db", "junk");
    mkdirSync(join(root, "Doomed/empty"), { recursive: true });
    await app.library.open(root);
    const nested = idOf("Doomed/deep/er/Nested -- Book.epub");

    const r = await shelves.remove(app, "Doomed");
    expect(r.moved.map((m) => m.to).sort()).toEqual(["Nested -- Book.epub", "Same -- Name (2).epub"]);
    expect(existsSync(join(root, "Doomed"))).toBe(false);
    expect(paths()).toEqual(["Nested -- Book.epub", "Same -- Name (2).epub", "Same -- Name.epub"]);
    expect(idOf("Nested -- Book.epub")).toBe(nested);
    expect(app.library.index.get("Nested -- Book.epub")!.shelf).toBeNull();
    await settle();
    expect(bookRepo.count(app.db)).toBe(3);
  });

  test("delete refuses (and touches nothing) when non-book files are present", async () => {
    put("Shelf/Book -- A.epub");
    put("Shelf/notes/readme.txt", "keep me");
    put("Shelf/.stfolder", "sync marker");
    await app.library.open(root);
    try {
      await shelves.remove(app, "Shelf");
      throw new Error("expected a conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).details).toEqual({ files: ["Shelf/.stfolder", "Shelf/notes/readme.txt"].sort(), total: 2 });
    }
    expect(paths()).toEqual(["Shelf/Book -- A.epub"]);
    expect(readdirSync(join(root, "Shelf")).sort()).toEqual([".stfolder", "Book -- A.epub", "notes"]);
  });
});

describe("moving books", () => {
  test("all files of a book move together; collisions get a counter; already-there files stay", async () => {
    put("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub", "e");
    put("A/Dune -- Frank Herbert -- isbn13 9780441172719.pdf", "p");
    put("A/Twin -- Author.epub", "twin in A");
    put("B/Twin -- Author.epub", "a different book with the same filename");
    put("B/Sub/Stay -- Here.epub");
    await app.library.open(root);
    const dune = idOf("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    expect(app.library.index.filesOfBook(dune)).toHaveLength(2);
    const twin = idOf("A/Twin -- Author.epub");
    const stay = idOf("B/Sub/Stay -- Here.epub");

    const r = await books.move(app, [dune, twin, stay], "B");
    expect(r.errors).toEqual([]);
    expect(r.moved.map((m) => m.to).sort()).toEqual([
      "B/Dune -- Frank Herbert -- isbn13 9780441172719.epub",
      "B/Dune -- Frank Herbert -- isbn13 9780441172719.pdf",
      "B/Twin -- Author (2).epub",
    ]);
    expect(app.library.index.filesOfBook(stay)[0]!.relPath).toBe("B/Sub/Stay -- Here.epub"); // already on B
    expect(readdirSync(join(root, "A"))).toEqual([]);

    await books.move(app, [dune], null);
    expect(app.library.index.filesOfBook(dune).map((f) => f.shelf)).toEqual([null, null]);
    await expect(books.move(app, [dune], "Nope")).rejects.toThrow(NotFoundError);
    await expect(books.move(app, [dune], "../etc")).rejects.toThrow(ValidationError);

    await settle();
    expect(bookRepo.count(app.db)).toBe(4);
    expect(app.library.index.size).toBe(5);
  });
});

describe("deleting", () => {
  test("unconfirmed metadata and cover go with the last file; confirmed metadata stays", async () => {
    put("S/a.epub", makeEpub({ metadataXml: "<dc:title>Plain</dc:title>", manifestXml: `<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>`, files: { "c.png": await makePng() } }));
    put("S/Kept -- Author.epub");
    await app.library.open(root);
    const plain = idOf("S/a.epub");
    const kept = idOf("S/Kept -- Author.epub");
    await Bun.sleep(50);
    expect(coverStore.exists(app.config.coversDir, plain)).toBe(true);
    await books.update(app, kept, { rating: 3 }); // confirms

    const r = await books.remove(app, [plain, kept]);
    expect(r.deletedFiles.toSorted()).toEqual(["S/Kept -- Author.epub", "S/a.epub"]);
    expect(r.removedMetadata).toEqual([plain]);
    expect(r.keptMetadata).toEqual([kept]);
    expect(bookRepo.exists(app.db, plain)).toBe(false);
    expect(coverStore.exists(app.config.coversDir, plain)).toBe(false);
    expect(bookRepo.exists(app.db, kept)).toBe(true);
    expect(readdirSync(join(root, "S"))).toEqual([]);
    expect(listLibrary(app.library.index, app.db, {}).total).toBe(0);
  });

  test("deleting one file of a multi-format book keeps the book", async () => {
    put("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub", "e");
    put("S/Dune -- Frank Herbert -- isbn13 9780441172719.pdf", "p");
    await app.library.open(root);
    const id = idOf("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    const pdf = app.library.index.get("S/Dune -- Frank Herbert -- isbn13 9780441172719.pdf")!;
    const r = await books.removeFile(app, id, pdf.hash);
    expect(r).toMatchObject({ deletedFiles: [pdf.relPath], keptMetadata: [], removedMetadata: [] });
    expect(app.library.index.filesOfBook(id).map((f) => f.format)).toEqual(["epub"]);
    await expect(books.removeFile(app, id, "nope")).rejects.toThrow(NotFoundError);
  });
});

describe("HTTP", () => {
  test("shelf names with spaces and percent signs; conflict details", async () => {
    put("100% Sci Fi/Book -- A.epub");
    put("Busy/readme.txt", "x");
    await app.library.open(root);
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const call = (path: string, method: string, body?: unknown) =>
        fetch(`${server.url}${path.slice(1)}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
      const renamed = await call(`/api/shelves/${encodeURIComponent("100% Sci Fi")}`, "PATCH", { name: "Sci-Fi & Fantasy" });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ name: "Sci-Fi & Fantasy", bookCount: 1 });
      expect((await call("/api/shelves", "POST", { name: "Sci-Fi & Fantasy" })).status).toBe(409);
      expect((await call("/api/shelves", "POST", { name: "New" })).status).toBe(201);
      expect((await call(`/api/shelves/${encodeURIComponent("a/b")}`, "DELETE")).status).toBe(400);
      const busy = await call("/api/shelves/Busy", "DELETE");
      expect(busy.status).toBe(409);
      expect((await busy.json()).details).toEqual({ files: ["Busy/readme.txt"], total: 1 });
      const del = await call(`/api/shelves/${encodeURIComponent("Sci-Fi & Fantasy")}`, "DELETE");
      expect(del.status).toBe(200);
      expect((await del.json()).moved).toEqual([{ from: "Sci-Fi & Fantasy/Book -- A.epub", to: "Book -- A.epub" }]);
      const id = idOf("Book -- A.epub");
      expect((await call("/api/books/move", "POST", { ids: [id], shelf: "New" })).status).toBe(200);
      expect((await call("/api/books/move", "POST", { ids: [id], shelf: 5 })).status).toBe(400);
      expect((await call(`/api/books/${id}`, "DELETE")).status).toBe(200);
      expect((await call(`/api/books/${id}`, "DELETE")).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
