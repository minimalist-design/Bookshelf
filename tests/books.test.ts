import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import { ConflictError } from "../src/server/api/http.ts";
import type { AppContext } from "../src/server/app.ts";
import { ValidationError } from "../src/server/library/paths.ts";
import { libraryFacets, listLibrary } from "../src/server/library/queries.ts";
import type { LibraryQuery } from "../src/shared/types.ts";
import { closeTestApp, makeBmp, makeEpub, makeJpeg, makePdf, makePng, scratchDir, testApp } from "./fixtures.ts";
import * as bookRepo from "../src/server/db/repo/books.ts";
import * as coverStore from "../src/server/covers/store.ts";
import * as books from "../src/server/services/books.ts";

let tmp: string;
let root: string;
let app: AppContext;

beforeEach(() => {
  ({ tmp, root } = scratchDir("books", ["Shelf"]));
  app = testApp(tmp);
});

afterEach(() => closeTestApp(app, tmp));

function put(rel: string, content: string | Uint8Array = rel) {
  writeFileSync(join(root, rel), content);
}
const list = (q: LibraryQuery = {}) => listLibrary(app.library.index, app.db, q).items;
const idOf = (rel: string) => app.library.index.get(rel)!.bookId;
const shelfFiles = () => readdirSync(join(root, "Shelf")).sort();

describe("edit", () => {
  test("title/author change renames every file, confirms, updates search; a rescan sees nothing new", async () => {
    put("Shelf/Frank Herbert - Dune [9780441172719].epub", "e");
    put("Shelf/dune scan.pdf", makePdf({ info: { Keywords: "ISBN 9780441172719" } }));
    await app.library.open(root);
    const id = idOf("Shelf/Frank Herbert - Dune [9780441172719].epub");
    expect(list()).toHaveLength(1);

    const r = await books.update(app, id, { title: "Dune: Deluxe Edition", authors: ["Herbert, Frank", "Brian Herbert"] });
    expect(r.book).toMatchObject({ title: "Dune: Deluxe Edition", authors: ["Frank Herbert", "Brian Herbert"], confirmedSource: "manual" });
    expect(r.renamed.map((x) => x.to).sort()).toEqual([
      "Shelf/Frank Herbert & Brian Herbert - Dune - Deluxe Edition [9780441172719].epub",
      "Shelf/Frank Herbert & Brian Herbert - Dune - Deluxe Edition [9780441172719].pdf",
    ]);
    expect(shelfFiles()).toEqual(r.renamed.map((x) => x.to.slice("Shelf/".length)).sort());
    expect(list({ q: "deluxe" }).map((b) => b.id)).toEqual([id]);
    expect(list({ q: "dune scan" })).toHaveLength(0);

    await app.library.rescan(); // the renamed files are already known: nothing is created or dropped
    expect(app.library.index.size).toBe(2);
    expect(bookRepo.count(app.db)).toBe(1);
  });

  test("non-name fields don't rename but still confirm; confirmed rows survive deletion", async () => {
    put("Shelf/Author - Book.epub");
    put("Someone - Other.epub"); // keeps the library from looking unmounted once the shelf is empty
    await app.library.open(root);
    const id = idOf("Shelf/Author - Book.epub");
    const r = await books.update(app, id, { rating: 4, tags: ["Fav", "fav", " SciFi "], notes: "Great", series: "S", seriesIndex: 2 });
    expect(r.renamed).toEqual([]);
    expect(r.book).toMatchObject({ rating: 4, tags: ["Fav", "SciFi"], notes: "Great", series: "S", seriesIndex: 2, confirmedSource: "manual" });
    expect(shelfFiles()).toEqual(["Author - Book.epub"]);

    expect((await books.update(app, id, { edition: "  2nd   ed. " })).book.edition).toBe("2nd ed.");
    expect((await books.update(app, id, { edition: "" })).book.edition).toBeNull();
    expect(shelfFiles()).toEqual(["Author - Book.epub"]);

    rmSync(join(root, "Shelf/Author - Book.epub"));
    await app.library.rescan();
    expect(app.library.index.hasBook(id)).toBe(false);
    expect(bookRepo.exists(app.db, id)).toBe(true);
  });

  test("an external confirmation is not downgraded to manual", async () => {
    put("Shelf/Author - Book.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Author - Book.epub");
    bookRepo.confirm(app.db, id, "openlibrary");
    expect((await books.update(app, id, { rating: 2 })).book.confirmedSource).toBe("openlibrary");
  });

  test("validation and identifier conflicts", async () => {
    put("Shelf/X - A [9780441172719].epub");
    put("Shelf/Y - B.epub");
    await app.library.open(root);
    const b = idOf("Shelf/Y - B.epub");
    await expect(books.update(app, b, { title: "  " })).rejects.toThrow(ValidationError);
    await expect(books.update(app, b, { isbn13: "123" })).rejects.toThrow(/ISBN/);
    await expect(books.update(app, b, { doi: "nope" })).rejects.toThrow(/DOI/);
    await expect(books.update(app, b, { rating: 6 })).rejects.toThrow(/Rating/);
    await expect(books.update(app, b, { publishedDate: "last year" })).rejects.toThrow(/date/);
    await expect(books.update(app, b, { isbn13: "978-0-441-17271-9" })).rejects.toThrow(ConflictError);
    await expect(books.update(app, 999, { title: "x" })).rejects.toThrow(/not found/);

    const ok = await books.update(app, b, { isbn13: "0131103628", publishedDate: "1988-04", series: null, seriesIndex: 3 });
    expect(ok.book).toMatchObject({ isbn13: "9780131103627", publishedDate: "1988-04", year: 1988, seriesIndex: null });
    // Conflicts name the other book, and no longer suggest merging (books can't be merged).
    await expect(books.update(app, b, { isbn13: "9780441172719" })).rejects.toThrow(/already has this ISBN$/);
    expect(ok.renamed[0]!.to).toBe("Shelf/Y - B [9780131103627].epub");
  });

  test("rename avoids collisions with unrelated files", async () => {
    put("Shelf/Y - B.epub", "someone else's file, not a book of ours"); // occupies the target name…
    put("Shelf/ours.epub", makeEpub({ metadataXml: "<dc:title>B</dc:title><dc:creator>Y</dc:creator>" }));
    await app.library.open(root);
    const ours = idOf("Shelf/ours.epub");
    // …but "Y - B.epub" is itself indexed as a (different) book; normalize ours:
    const r = await books.normalizeFilenames(app, [ours]);
    expect(r.renamed).toEqual([{ from: "Shelf/ours.epub", to: "Shelf/Y - B (2).epub" }]);
    expect(bookRepo.get(app.db, ours)!.confirmedSource).toBeNull(); // normalizing is not an edit
  });
});

describe("covers", () => {
  test("upload and remove a cover (confirms); the upload is kept byte for byte", async () => {
    put("Shelf/Author - Book.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Author - Book.epub");
    await expect(books.setCover(app, id, new TextEncoder().encode("not an image"))).rejects.toThrow(ValidationError);
    const jpeg = await makeJpeg(2400, 3600); // larger than any size covers used to be shrunk to
    await books.setCover(app, id, jpeg);
    expect(bookRepo.get(app.db, id)).toMatchObject({ hasCover: true, coverSource: "upload", confirmedSource: "manual" });
    const cover = coverStore.find(app.config.coversDir, id)!;
    expect(cover.contentType).toBe("image/jpeg");
    expect(readFileSync(cover.path).equals(jpeg)).toBe(true);
    await books.removeCover(app, id);
    expect(bookRepo.get(app.db, id)!.hasCover).toBe(false);
    expect(coverStore.exists(app.config.coversDir, id)).toBe(false);
  });

  test("a format browsers can't show becomes a PNG of the same size; a new cover replaces the old file", async () => {
    put("Shelf/Author - Book.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Author - Book.epub");
    const coverFiles = () => readdirSync(app.config.coversDir).filter((f) => f.startsWith(`${id}.`));

    await books.setCover(app, id, makeBmp(500, 700));
    const bmp = coverStore.find(app.config.coversDir, id)!;
    expect(bmp.contentType).toBe("image/png");
    const meta = await new Bun.Image(readFileSync(bmp.path)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 500, 700]);

    await books.setCover(app, id, await makeJpeg(30, 45));
    expect(coverFiles()).toEqual([`${id}.jpg`]);
    await books.setCover(app, id, await makePng(30, 45));
    expect(coverFiles()).toEqual([`${id}.png`]);
    await expect(books.setCover(app, id, await makePng(10, 10))).rejects.toThrow(ValidationError); // too small to be a cover
  });

  test("the cover endpoint serves the stored file with its own type", async () => {
    put("Shelf/Author - Book.epub");
    await app.library.open(root);
    const id = idOf("Shelf/Author - Book.epub");
    const jpeg = await makeJpeg(400, 600);
    await books.setCover(app, id, jpeg);
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      for (const query of ["", "?size=thumb"]) {
        const res = await fetch(`${server.url}api/books/${id}/cover${query}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/jpeg");
        expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(jpeg.byteLength);
      }
      const etag = (await fetch(`${server.url}api/books/${id}/cover`)).headers.get("etag")!;
      expect((await fetch(`${server.url}api/books/${id}/cover`, { headers: { "if-none-match": etag } })).status).toBe(304);
      await books.removeCover(app, id);
      expect((await fetch(`${server.url}api/books/${id}/cover`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("thumbnails left by earlier versions are removed at startup; the covers next to them still serve", async () => {
    const dir = app.config.coversDir;
    await closeTestApp(app);
    writeFileSync(join(dir, "7.jpg"), await makeJpeg());
    writeFileSync(join(dir, "7.thumb.webp"), "old thumbnail");
    app = testApp(tmp);
    expect(existsSync(join(dir, "7.thumb.webp"))).toBe(false);
    expect(coverStore.find(dir, 7)).toEqual({ path: join(dir, "7.jpg"), contentType: "image/jpeg" });
  });
});

describe("listing filters and facets", () => {
  test("format, tag, series, author, confirmed, missing, rating, series sort", async () => {
    put("Shelf/a.epub", makeEpub({ metadataXml: "<dc:title>Alpha</dc:title><dc:creator>Ann</dc:creator><dc:subject>Sci</dc:subject><dc:identifier>urn:isbn:9780441172719</dc:identifier>" }));
    put("Shelf/Bob - Beta.pdf", makePdf());
    put("Shelf/Ann - Gamma.cbz", "not really a zip");
    await app.library.open(root);
    const beta = idOf("Shelf/Bob - Beta.pdf");
    const gamma = idOf("Shelf/Ann - Gamma.cbz");
    await books.update(app, beta, { series: "Saga", seriesIndex: 2, rating: 5, tags: ["sci"] });
    await books.update(app, gamma, { series: "Saga", seriesIndex: 1 });

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

    const f = libraryFacets(app.library.index, app.db);
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
  test("PATCH, normalize-filenames (static route wins over :id), conflicts, removed routes", async () => {
    put("Shelf/Author - Book.epub");
    put("Shelf/other.epub", makeEpub({ metadataXml: "<dc:title>Other</dc:title><dc:creator>Author</dc:creator><dc:identifier>urn:isbn:9780441172719</dc:identifier>" }));
    await app.library.open(root);
    const id = idOf("Shelf/Author - Book.epub");
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const call = (path: string, method: string, body?: unknown) =>
        fetch(`${server.url}${path.slice(1)}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
      const patched = await call(`/api/books/${id}`, "PATCH", { title: "New Title" });
      expect(patched.status).toBe(200);
      expect((await patched.json()).renamed[0].to).toBe("Shelf/Author - New Title.epub");
      expect((await call(`/api/books/${id}`, "PATCH", { isbn13: "9780441172719" })).status).toBe(409);
      expect((await call(`/api/books/${id}`, "PATCH", { rating: "five" })).status).toBe(400);
      const norm = await call("/api/books/normalize-filenames", "POST", { ids: [idOf("Shelf/other.epub")] });
      expect(norm.status).toBe(200);
      expect((await norm.json()).renamed[0].to).toBe("Shelf/Author - Other [9780441172719].epub");
      expect((await call("/api/books/normalize-filenames", "POST", { ids: ["x"] })).status).toBe(400);
      // Merging, detaching, name cleanup and maintenance are gone.
      expect((await call(`/api/books/${id}/merge`, "POST", { intoId: id })).status).toBe(404);
      const hash = app.library.index.filesOfBook(id)[0]!.hash;
      expect((await call(`/api/books/${id}/files/${hash}/detach`, "POST")).status).toBe(404);
      expect((await call("/api/cleanup/groups?field=authors", "GET")).status).toBe(404);
      expect((await call("/api/maintenance/stats", "GET")).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
