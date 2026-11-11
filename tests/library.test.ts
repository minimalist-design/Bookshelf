import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { listLibrary, listShelves } from "../src/server/library/queries.ts";
import { makeEpub, makePdf, makePng, xmpPacket } from "./fixtures.ts";

const FAST = { debounceMs: 30, stableMs: 80, graceMs: 300, pollIntervalMs: 60_000 };

let tmp: string;
let root: string;
let dataDir: string;
const apps: AppContext[] = [];

function newApp(): AppContext {
  const app = createApp(loadConfig({ BOOKSHELF_DATA_DIR: dataDir }), { library: FAST });
  apps.push(app);
  return app;
}

function put(rel: string, content: string | Uint8Array = rel): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

const list = (app: AppContext, query = {}) => listLibrary(app.library.index, app.books, query);
const titles = (app: AppContext, query = {}) => list(app, query).items.map((b) => b.title);
const bookIdOf = (app: AppContext, rel: string) => app.library.index.get(rel)?.bookId;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bookshelf-lib-"));
  root = join(tmp, "library");
  dataDir = join(tmp, "data");
  mkdirSync(root, { recursive: true });
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.library.close();
    app.db.close();
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("full scan", () => {
  test("indexes shelves, unshelved and nested files; ignores hidden/partial/unsupported", async () => {
    put("Loose Book -- Jane Doe.epub");
    put("Fiction/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    put("Fiction/Deep/Nested/Emma -- Jane Austen.pdf");
    put("Science/Brian Greene - The Elegant Universe [9780393338102].pdf");
    put("Science/.hidden/Secret -- X.epub");
    put(".bookshelf-incoming/tmp.epub");
    put("Science/partial.epub.part");
    put("Science/notes.txt");
    put("EmptyShelf/.keep");

    const app = newApp();
    await app.library.open(root);

    expect(app.library.status()).toMatchObject({ state: "ready", fileCount: 4, bookCount: 4 });
    expect(titles(app)).toEqual(["Dune", "The Elegant Universe", "Emma", "Loose Book"]);
    expect(titles(app, { shelf: "" })).toEqual(["Loose Book"]);
    expect(titles(app, { shelf: "Fiction" })).toEqual(["Dune", "Emma"]);

    const dune = list(app, { shelf: "Fiction" }).items[0]!;
    expect(dune).toMatchObject({ authors: ["Frank Herbert"], isbn13: "9780441172719", metadataSource: "filename" });
    const greene = list(app, { shelf: "Science" }).items[0]!;
    expect(greene).toMatchObject({ authors: ["Brian Greene"], isbn13: "9780393338102" });

    expect(listShelves(root, app.library.index)).toEqual([
      { name: null, bookCount: 1 },
      { name: "EmptyShelf", bookCount: 0 },
      { name: "Fiction", bookCount: 2 },
      { name: "Science", bookCount: 1 },
    ]);
  });

  test("sorting and full-text search", async () => {
    put("A/The Zebra Book -- Zed Adams.epub");
    put("A/Apples -- Mary Young -- isbn13 9780131103627.epub");
    put("A/Middle -- Bob Martin.epub");
    const app = newApp();
    await app.library.open(root);

    expect(titles(app)).toEqual(["Apples", "Middle", "The Zebra Book"]); // leading article ignored
    expect(titles(app, { sort: "author" })).toEqual(["The Zebra Book", "Middle", "Apples"]);
    expect(titles(app, { sort: "title", order: "desc" })).toEqual(["The Zebra Book", "Middle", "Apples"]);
    expect(titles(app, { q: "zeb" })).toEqual(["The Zebra Book"]);
    expect(titles(app, { q: "mary apples" })).toEqual(["Apples"]);
    expect(titles(app, { q: "9780131103627" })).toEqual(["Apples"]);
    expect(titles(app, { q: 'NOT "(' })).toEqual([]); // operators are literal, no FTS syntax errors
  });

  test("same identifier: different formats share one book, same format does not", async () => {
    put("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub", "epub bytes");
    put("B/Dune -- Frank Herbert -- isbn13 9780441172719.pdf", "pdf bytes");
    put("C/Dune copy -- Frank Herbert -- isbn13 9780441172719.pdf", "other pdf bytes");
    const app = newApp();
    await app.library.open(root);

    const books = list(app).items;
    expect(books).toHaveLength(2);
    const multi = books.find((b) => b.files.length === 2)!;
    expect(multi.files.map((f) => f.format).sort()).toEqual(["epub", "pdf"]);
    // Either PDF may be attached (scan order); the other one becomes its own book.
    const pdfShelf = multi.shelves.find((s) => s !== "A")!;
    expect(["B", "C"]).toContain(pdfShelf);
    const single = books.find((b) => b.id !== multi.id)!;
    expect(single.files.map((f) => f.format)).toEqual(["pdf"]);
    // The book appears on both shelves it has files in.
    expect(list(app, { shelf: "A" }).items.map((b) => b.id)).toEqual([multi.id]);
    expect(list(app, { shelf: pdfShelf }).items.map((b) => b.id)).toEqual([multi.id]);
  });

  test("metadata survives a restart (linked by hash, not path)", async () => {
    put("A/Dune -- Frank Herbert.epub");
    let app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Dune -- Frank Herbert.epub")!;
    await app.library.close();

    // Rename while the server is down: the hash still links it.
    mkdirSync(join(root, "B"));
    renameSync(join(root, "A/Dune -- Frank Herbert.epub"), join(root, "B/renamed.epub"));
    app = newApp();
    await app.library.open(root);
    expect(bookIdOf(app, "B/renamed.epub")).toBe(id);
    expect(app.books.get(id)!.title).toBe("Dune");
  });
});

describe("retention on startup", () => {
  test("unconfirmed rows without files are deleted, confirmed rows are kept", async () => {
    put("A/Keep -- Someone.epub");
    put("A/Drop -- Someone.epub");
    let app = newApp();
    await app.library.open(root);
    const keep = bookIdOf(app, "A/Keep -- Someone.epub")!;
    const drop = bookIdOf(app, "A/Drop -- Someone.epub")!;
    app.db.query("UPDATE books SET confirmed_source = 'openlibrary' WHERE id = ?").run(keep);
    await app.library.close();

    rmSync(join(root, "A/Keep -- Someone.epub"));
    rmSync(join(root, "A/Drop -- Someone.epub"));
    put("A/Other -- Person.epub"); // library is not empty
    app = newApp();
    await app.library.open(root);
    expect(app.books.exists(keep)).toBe(true);
    expect(app.books.exists(drop)).toBe(false);
    expect(list(app).items.map((b) => b.title)).toEqual(["Other"]);

    // The kept row reconnects when the file comes back.
    put("Elsewhere/whatever.epub", "A/Keep -- Someone.epub"); // same bytes as before
    await app.library.rescan();
    expect(bookIdOf(app, "Elsewhere/whatever.epub")).toBe(keep);
  });

  test("an empty/unmounted library never purges metadata", async () => {
    put("A/Book -- Someone.epub");
    let app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Book -- Someone.epub")!;
    await app.library.close();

    rmSync(join(root, "A"), { recursive: true });
    app = newApp();
    await app.library.open(root);
    expect(app.books.exists(id)).toBe(true);
    expect(app.library.status().message).toMatch(/mounted/);

    await app.library.close();
    rmSync(root, { recursive: true });
    app = newApp();
    await app.library.open(root);
    expect(app.library.status().state).toBe("unavailable");
    expect(app.books.exists(id)).toBe(true);
  });
});

describe("watcher", () => {
  test("new files appear, deleted unconfirmed books disappear with their metadata", async () => {
    const app = newApp();
    await app.library.open(root);
    put("Shelf/New Book -- Author.epub");
    await waitFor(() => titles(app).includes("New Book"));
    const id = bookIdOf(app, "Shelf/New Book -- Author.epub")!;

    rmSync(join(root, "Shelf/New Book -- Author.epub"));
    await waitFor(() => !app.library.index.hasBook(id));
    expect(app.books.exists(id)).toBe(true); // grace period
    await waitFor(() => !app.books.exists(id));
  });

  test("confirmed metadata is kept after an external delete", async () => {
    put("Shelf/Kept -- Author.epub");
    const app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "Shelf/Kept -- Author.epub")!;
    app.db.query("UPDATE books SET confirmed_source = 'manual' WHERE id = ?").run(id);
    rmSync(join(root, "Shelf/Kept -- Author.epub"));
    await waitFor(() => !app.library.index.hasBook(id));
    await Bun.sleep(FAST.graceMs + 150);
    expect(app.books.exists(id)).toBe(true);
    expect(titles(app)).toEqual([]);
  });

  test("moving a file between shelves keeps its metadata (no deletion after grace)", async () => {
    put("A/Moved -- Author.epub");
    const app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Moved -- Author.epub")!;
    mkdirSync(join(root, "B"));
    renameSync(join(root, "A/Moved -- Author.epub"), join(root, "B/Moved -- Author.epub"));
    await waitFor(() => bookIdOf(app, "B/Moved -- Author.epub") === id && !app.library.index.get("A/Moved -- Author.epub"));
    await Bun.sleep(FAST.graceMs + 150);
    expect(app.books.exists(id)).toBe(true);
    expect(list(app, { shelf: "B" }).items.map((b) => b.id)).toEqual([id]);
  });

  test("renaming a shelf directory keeps every book", async () => {
    put("Old/One -- A.epub");
    put("Old/Sub/Two -- B.pdf");
    const app = newApp();
    await app.library.open(root);
    const ids = list(app).items.map((b) => b.id).sort();
    renameSync(join(root, "Old"), join(root, "New"));
    await waitFor(() => list(app, { shelf: "New" }).total === 2 && list(app, { shelf: "Old" }).total === 0);
    await Bun.sleep(FAST.graceMs + 150);
    expect(list(app).items.map((b) => b.id).sort()).toEqual(ids);
    expect(ids.every((id) => app.books.exists(id))).toBe(true);
  });

  test("a file still being written is processed once stable", async () => {
    const app = newApp();
    await app.library.open(root);
    const abs = put("Growing -- Author.pdf", "part1");
    await Bun.sleep(40);
    appendFileSync(abs, "part2");
    await waitFor(() => titles(app).includes("Growing"));
    expect(app.library.index.get("Growing -- Author.pdf")!.size).toBe(10);
  });

  test("content change with the same ISBN stays the same book", async () => {
    put("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub", "v1");
    const app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Dune -- Frank Herbert -- isbn13 9780441172719.epub")!;
    const oldHash = app.library.index.get("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub")!.hash;
    await Bun.sleep(20);
    writeFileSync(join(root, "A/Dune -- Frank Herbert -- isbn13 9780441172719.epub"), "v2 with more bytes");
    await waitFor(() => app.library.index.get("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub")?.hash !== oldHash);
    expect(bookIdOf(app, "A/Dune -- Frank Herbert -- isbn13 9780441172719.epub")).toBe(id);
    await Bun.sleep(FAST.graceMs + 150);
    expect(app.books.exists(id)).toBe(true);
  });
});

describe("embedded metadata and covers", () => {
  async function epub(title: string, author: string, isbn: string) {
    return makeEpub({
      metadataXml: `<dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:identifier>urn:isbn:${isbn}</dc:identifier>
        <dc:subject>Classic</dc:subject>`,
      manifestXml: `<item id="c" href="cover.png" media-type="image/png" properties="cover-image"/>`,
      files: { "cover.png": await makePng(300, 450) },
    });
  }

  test("embedded metadata is used and the cover stored; filename fills gaps", async () => {
    put("Shelf/download (1).epub", await epub("Embedded Title", "Embedded Author", "9780441172719"));
    put("Shelf/Paper From Filename -- Some Body.pdf", makePdf({ info: { Title: "untitled", Author: "Administrator" } }));
    const app = newApp();
    await app.library.open(root);

    const e = list(app, { q: "Embedded" }).items[0]!;
    expect(e).toMatchObject({ title: "Embedded Title", authors: ["Embedded Author"], isbn13: "9780441172719", tags: ["Classic"], metadataSource: "embedded" });
    await waitFor(() => app.books.get(e.id)!.hasCover);
    expect(app.covers.exists(e.id)).toBe(true);
    const thumb = await sharp(app.covers.path(e.id, "thumb")).metadata();
    expect([thumb.width, thumb.height, thumb.format]).toEqual([300, 450, "webp"]);

    const p = list(app, { q: "Paper" }).items[0]!;
    expect(p).toMatchObject({ title: "Paper From Filename", authors: ["Some Body"], metadataSource: "filename" });
  });

  test("a PDF with the same embedded ISBN is attached to the EPUB's book and covers are cleaned up with the row", async () => {
    put("A/x.epub", await epub("Dune", "Frank Herbert", "9780441172719"));
    put("B/y.pdf", makePdf({ info: { Title: "Dune (scan)", Keywords: "ISBN 9780441172719" } }));
    const app = newApp();
    await app.library.open(root);
    const books = list(app).items;
    expect(books).toHaveLength(1);
    expect(books[0]!.files.map((f) => f.format).sort()).toEqual(["epub", "pdf"]);
    const id = books[0]!.id;
    await waitFor(() => app.covers.exists(id));

    rmSync(join(root, "A/x.epub"));
    rmSync(join(root, "B/y.pdf"));
    await waitFor(() => !app.books.exists(id));
    expect(app.covers.exists(id)).toBe(false);
  });

  test("DOI from PDF XMP links papers", async () => {
    put("Papers/a.pdf", makePdf({ xmp: xmpPacket({ title: "Attention Is All You Need", creators: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"], doi: "10.48550/arXiv.1706.03762" }) }));
    const app = newApp();
    await app.library.open(root);
    expect(list(app).items[0]).toMatchObject({ title: "Attention Is All You Need", doi: "10.48550/arXiv.1706.03762", authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"] });
  });

  test("a better format attached later takes over unconfirmed metadata and cover; a worse one only fills gaps", async () => {
    put("A/scan.pdf", makePdf({ info: { Title: "Dune (scan)", Keywords: "ISBN 9780441172719" }, pages: 2 }));
    const app = newApp();
    await app.library.open(root);
    const id = list(app).items[0]!.id;
    await waitFor(() => app.books.get(id)!.hasCover);
    const pdfCover = Bun.file(app.covers.path(id, "full")).size;
    expect(app.books.get(id)).toMatchObject({ title: "Dune (scan)", authors: [], pages: 2 });

    put("A/book.epub", await epub("Dune", "Frank Herbert", "9780441172719"));
    await waitFor(() => app.books.get(id)!.title === "Dune");
    expect(app.books.get(id)).toMatchObject({ authors: ["Frank Herbert"], pages: 2, tags: ["Classic"], metadataSource: "embedded" });
    await waitFor(() => Bun.file(app.covers.path(id, "full")).size !== pdfCover); // EPUB cover replaced the rendered page
    expect(list(app).items).toHaveLength(1);
  });

  test("confirmed metadata is never rewritten by an attached file", async () => {
    put("A/scan.pdf", makePdf({ info: { Title: "My Corrected Title", Keywords: "ISBN 9780441172719" } }));
    const app = newApp();
    await app.library.open(root);
    const id = list(app).items[0]!.id;
    app.db.query("UPDATE books SET confirmed_source = 'manual' WHERE id = ?").run(id);
    put("A/book.epub", await epub("Dune", "Frank Herbert", "9780441172719"));
    await waitFor(() => app.library.index.filesOfBook(id).length === 2);
    expect(app.books.get(id)).toMatchObject({ title: "My Corrected Title", authors: [] });
  });
});
