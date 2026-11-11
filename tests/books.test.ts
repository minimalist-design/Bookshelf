import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import { ConflictError } from "../src/server/api/http.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { ValidationError } from "../src/server/library/paths.ts";
import { libraryFacets, listLibrary } from "../src/server/library/queries.ts";
import type { LibraryQuery } from "../src/shared/types.ts";
import { makeEpub, makeJpeg, makePdf } from "./fixtures.ts";

const FAST = { debounceMs: 30, stableMs: 80, graceMs: 300 };
let tmp: string;
let root: string;
let app: AppContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bookshelf-books-"));
  root = join(tmp, "library");
  mkdirSync(join(root, "Shelf"), { recursive: true });
  app = createApp(loadConfig({ BOOKSHELF_DATA_DIR: join(tmp, "data") }), { library: FAST });
});

afterEach(async () => {
  await app.library.close();
  app.db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function put(rel: string, content: string | Uint8Array = rel) {
  writeFileSync(join(root, rel), content);
}
const list = (q: LibraryQuery = {}) => listLibrary(app.library.index, app.books, q).items;
const idOf = (rel: string) => app.library.index.get(rel)!.bookId;
const shelfFiles = () => readdirSync(join(root, "Shelf")).sort();

describe("edit", () => {
  test("title/author change renames every file, confirms, updates search; watcher stays quiet", async () => {
    put("Shelf/Dune -- Frank Herbert -- isbn13 9780441172719.epub", "e");
    put("Shelf/dune scan.pdf", makePdf({ info: { Keywords: "ISBN 9780441172719" } }));
    await app.library.open(root);
    const id = idOf("Shelf/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    expect(list()).toHaveLength(1);

    const r = await app.bookService.update(id, { title: "Dune: Deluxe Edition", authors: ["Herbert, Frank", "Brian Herbert"] });
    expect(r.book).toMatchObject({ title: "Dune: Deluxe Edition", authors: ["Frank Herbert", "Brian Herbert"], confirmedSource: "manual" });
    expect(r.renamed.map((x) => x.to).sort()).toEqual([
      "Shelf/Frank Herbert & Brian Herbert - Dune - Deluxe Edition [9780441172719].epub",
      "Shelf/Frank Herbert & Brian Herbert - Dune - Deluxe Edition [9780441172719].pdf",
    ]);
    expect(shelfFiles()).toEqual(r.renamed.map((x) => x.to.slice("Shelf/".length)).sort());
    expect(list({ q: "deluxe" }).map((b) => b.id)).toEqual([id]);
    expect(list({ q: "dune scan" })).toHaveLength(0);

    await Bun.sleep(500); // watcher events for the renames must not create or drop anything
    expect(app.library.index.size).toBe(2);
    expect(app.books.count()).toBe(1);
  });

  test("non-name fields don't rename but still confirm; confirmed rows survive deletion", async () => {
    put("Shelf/Book -- Author.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Book -- Author.epub");
    const r = await app.bookService.update(id, { rating: 4, tags: ["Fav", "fav", " SciFi "], notes: "Great", series: "S", seriesIndex: 2 });
    expect(r.renamed).toEqual([]);
    expect(r.book).toMatchObject({ rating: 4, tags: ["Fav", "SciFi"], notes: "Great", series: "S", seriesIndex: 2, confirmedSource: "manual" });
    expect(shelfFiles()).toEqual(["Book -- Author.epub"]);

    rmSync(join(root, "Shelf/Book -- Author.epub"));
    await Bun.sleep(FAST.graceMs + 400);
    expect(app.books.exists(id)).toBe(true);
  });

  test("an external confirmation is not downgraded to manual", async () => {
    put("Shelf/Book -- Author.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Book -- Author.epub");
    app.books.confirm(id, "openlibrary");
    expect((await app.bookService.update(id, { rating: 2 })).book.confirmedSource).toBe("openlibrary");
  });

  test("validation and identifier conflicts", async () => {
    put("Shelf/A -- X -- isbn13 9780441172719.epub");
    put("Shelf/B -- Y.epub");
    await app.library.open(root);
    const b = idOf("Shelf/B -- Y.epub");
    await expect(app.bookService.update(b, { title: "  " })).rejects.toThrow(ValidationError);
    await expect(app.bookService.update(b, { isbn13: "123" })).rejects.toThrow(/ISBN/);
    await expect(app.bookService.update(b, { doi: "nope" })).rejects.toThrow(/DOI/);
    await expect(app.bookService.update(b, { rating: 6 })).rejects.toThrow(/Rating/);
    await expect(app.bookService.update(b, { publishedDate: "last year" })).rejects.toThrow(/date/);
    await expect(app.bookService.update(b, { isbn13: "978-0-441-17271-9" })).rejects.toThrow(ConflictError);
    await expect(app.bookService.update(999, { title: "x" })).rejects.toThrow(/not found/);

    const ok = await app.bookService.update(b, { isbn13: "0131103628", publishedDate: "1988-04", series: null, seriesIndex: 3 });
    expect(ok.book).toMatchObject({ isbn13: "9780131103627", publishedDate: "1988-04", year: 1988, seriesIndex: null });
    expect(ok.renamed[0]!.to).toBe("Shelf/Y - B [9780131103627].epub");
  });

  test("rename avoids collisions with unrelated files", async () => {
    put("Shelf/Y - B.epub", "someone else's file, not a book of ours"); // occupies the target name…
    put("Shelf/B -- Y.epub", "ours");
    await app.library.open(root);
    const ours = idOf("Shelf/B -- Y.epub");
    // …but "Y - B.epub" is itself indexed as a (different) book; normalize ours:
    const r = await app.bookService.normalizeFilenames([ours]);
    expect(r.renamed).toEqual([{ from: "Shelf/B -- Y.epub", to: "Shelf/Y - B (2).epub" }]);
    expect(app.books.get(ours)!.confirmedSource).toBeNull(); // normalizing is not an edit
  });
});

describe("merge and detach", () => {
  test("merge two books without identifiers; refuse same-format merges", async () => {
    put("Shelf/My Notes -- Me.epub", "epub");
    put("Shelf/my-notes-print.pdf", makePdf({ info: { Title: "My Notes (print)", Author: "Me" }, pages: 7 }));
    put("Shelf/Other -- Me.epub", "other epub");
    await app.library.open(root);
    const epub = idOf("Shelf/My Notes -- Me.epub");
    const pdf = idOf("Shelf/my-notes-print.pdf");
    const other = idOf("Shelf/Other -- Me.epub");

    await expect(app.bookService.merge(other, epub)).rejects.toThrow(/EPUB/);
    const r = await app.bookService.merge(pdf, epub);
    expect(r.book).toMatchObject({ id: epub, title: "My Notes", pages: 7, confirmedSource: "manual" });
    expect(r.book.files.map((f) => f.format).sort()).toEqual(["epub", "pdf"]);
    expect(app.books.exists(pdf)).toBe(false);
    expect(shelfFiles()).toEqual(["Me - My Notes.epub", "Me - My Notes.pdf", "Other -- Me.epub"]);

    // Survives a restart: both hashes now belong to the merged book.
    await app.library.close();
    await app.library.open(root);
    expect(list().find((b) => b.id === epub)!.files).toHaveLength(2);
  });

  test("detach splits a file into its own unconfirmed book, stable across rescans", async () => {
    put("Shelf/Dune -- Frank Herbert -- isbn13 9780441172719.epub", "e");
    put("Shelf/Wrong Book -- Someone -- isbn13 9780441172719.pdf", makePdf());
    await app.library.open(root);
    const id = idOf("Shelf/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    const pdfFile = app.library.index.get("Shelf/Wrong Book -- Someone -- isbn13 9780441172719.pdf")!;
    expect(pdfFile.bookId).toBe(id);

    await expect(app.bookService.detach(id, "nope")).rejects.toThrow(/not found/);
    const r = await app.bookService.detach(id, pdfFile.hash);
    expect(r.book).toMatchObject({ title: "Wrong Book", authors: ["Someone"], confirmedSource: null });
    expect(r.book.id).not.toBe(id);
    expect(list()).toHaveLength(2);
    await expect(app.bookService.detach(id, app.library.index.filesOfBook(id)[0]!.hash)).rejects.toThrow(/only this file/);

    await app.library.rescan();
    expect(app.library.index.get(pdfFile.relPath)!.bookId).toBe(r.book.id);
  });
});

describe("covers", () => {
  test("upload and remove a cover (confirms)", async () => {
    put("Shelf/Book -- Author.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Book -- Author.epub");
    await expect(app.bookService.setCover(id, new TextEncoder().encode("not an image"))).rejects.toThrow(ValidationError);
    await app.bookService.setCover(id, await makeJpeg(400, 600));
    expect(app.books.get(id)).toMatchObject({ hasCover: true, coverSource: "upload", confirmedSource: "manual" });
    expect(existsSync(app.covers.path(id, "thumb"))).toBe(true);
    await app.bookService.removeCover(id);
    expect(app.books.get(id)!.hasCover).toBe(false);
    expect(existsSync(app.covers.path(id, "full"))).toBe(false);
  });
});

describe("listing filters and facets", () => {
  test("format, tag, series, author, confirmed, missing, rating, series sort", async () => {
    put("Shelf/a.epub", makeEpub({ metadataXml: "<dc:title>Alpha</dc:title><dc:creator>Ann</dc:creator><dc:subject>Sci</dc:subject><dc:identifier>urn:isbn:9780441172719</dc:identifier>" }));
    put("Shelf/Beta -- Bob.pdf", makePdf());
    put("Shelf/Gamma -- Ann.cbz", "not really a zip");
    await app.library.open(root);
    const beta = idOf("Shelf/Beta -- Bob.pdf");
    const gamma = idOf("Shelf/Gamma -- Ann.cbz");
    await app.bookService.update(beta, { series: "Saga", seriesIndex: 2, rating: 5, tags: ["sci"] });
    await app.bookService.update(gamma, { series: "Saga", seriesIndex: 1 });

    const titles = (q: LibraryQuery) => list(q).map((b) => b.title);
    expect(titles({ format: "pdf" })).toEqual(["Beta"]);
    expect(titles({ tag: "SCI" })).toEqual(["Alpha", "Beta"]);
    expect(titles({ author: "ann" })).toEqual(["Alpha", "Gamma"]);
    expect(titles({ series: "saga" })).toEqual(["Beta", "Gamma"]);
    expect(titles({ confirmed: false })).toEqual(["Alpha"]);
    expect(titles({ missing: "id" })).toEqual(["Beta", "Gamma"]);
    expect(titles({ minRating: 4 })).toEqual(["Beta"]);
    expect(titles({ sort: "series" })).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(titles({ sort: "series", order: "desc" })).toEqual(["Beta", "Gamma", "Alpha"]);

    const f = libraryFacets(app.library.index, app.books);
    expect(f.tags).toEqual([{ name: "Sci", count: 2 }]); // tags are case-insensitive: "sci" reuses "Sci"
    expect(f.series).toEqual([{ name: "Saga", count: 2 }]);
    expect(f.formats).toEqual([
      { name: "cbz", count: 1 },
      { name: "epub", count: 1 },
      { name: "pdf", count: 1 },
    ]);
    expect(f.authors).toEqual([
      { name: "Ann", count: 2 },
      { name: "Bob", count: 1 },
    ]);
  });
});

describe("HTTP", () => {
  test("PATCH, normalize-filenames (static route wins over :id), conflicts", async () => {
    put("Shelf/Book -- Author.epub");
    put("Shelf/Other -- Author -- isbn13 9780441172719.epub", "x");
    await app.library.open(root);
    const id = idOf("Shelf/Book -- Author.epub");
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const call = (path: string, method: string, body?: unknown) =>
        fetch(`${server.url}${path.slice(1)}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
      const patched = await call(`/api/books/${id}`, "PATCH", { title: "New Title" });
      expect(patched.status).toBe(200);
      expect((await patched.json()).renamed[0].to).toBe("Shelf/Author - New Title.epub");
      expect((await call(`/api/books/${id}`, "PATCH", { isbn13: "9780441172719" })).status).toBe(409);
      expect((await call(`/api/books/${id}`, "PATCH", { rating: "five" })).status).toBe(400);
      const norm = await call("/api/books/normalize-filenames", "POST", { ids: [idOf("Shelf/Other -- Author -- isbn13 9780441172719.epub")] });
      expect(norm.status).toBe(200);
      expect((await norm.json()).renamed[0].to).toBe("Shelf/Author - Other [9780441172719].epub");
      expect((await call("/api/books/normalize-filenames", "POST", { ids: ["x"] })).status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});
