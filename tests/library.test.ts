import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import type { IndexedFile } from "../src/server/library/libraryIndex.ts";
import { listLibrary, listShelves, shelvesFrom } from "../src/server/library/queries.ts";
import { closeTestApp, makeEpub, makePdf, makePng, scratchDir, xmpPacket } from "./fixtures.ts";
import * as bookRepo from "../src/server/db/repo/books.ts";
import * as coverStore from "../src/server/covers/store.ts";

let tmp: string;
let root: string;
let dataDir: string;
const apps: AppContext[] = [];

function newApp(): AppContext {
  const app = createApp(loadConfig({ data_dir: dataDir }));
  apps.push(app);
  return app;
}

function put(rel: string, content: string | Uint8Array = rel): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

const list = (app: AppContext, query = {}) => listLibrary(app.library.index, app.db, query);
const titles = (app: AppContext, query = {}) => list(app, query).items.map((b) => b.title);
const bookIdOf = (app: AppContext, rel: string) => app.library.index.get(rel)?.bookId;

beforeEach(() => {
  ({ tmp, root } = scratchDir("lib"));
  dataDir = join(tmp, "data");
});

afterEach(async () => {
  for (const app of apps.splice(0)) await closeTestApp(app);
  await closeTestApp(undefined, tmp);
});

describe("full scan", () => {
  test("indexes shelves, unshelved and nested files; ignores hidden/partial/unsupported", async () => {
    put("Jane Doe - Loose Book.epub");
    put("Fiction/Frank Herbert - Dune [9780441172719].epub");
    put("Fiction/Deep/Nested/Jane Austen - Emma.pdf");
    put("Science/Brian Greene - The Elegant Universe [9780393338102].pdf");
    put("Science/.hidden/X - Secret.epub");
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

  test("a filename not in Bookshelf's style is the title, with nothing guessed from it", async () => {
    put("A/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    const app = newApp();
    await app.library.open(root);
    expect(list(app).items[0]).toMatchObject({
      title: "Dune -- Frank Herbert -- isbn13 9780441172719",
      authors: [],
      isbn13: null,
      metadataSource: "filename",
    });
  });

  test("sorting and full-text search", async () => {
    put("A/Zed Adams - The Zebra Book.epub");
    put("A/Mary Young - Apples [9780131103627].epub");
    put("A/Bob Martin - Middle.epub");
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
    put("A/Frank Herbert - Dune [9780441172719].epub", "epub bytes");
    put("B/Frank Herbert - Dune [9780441172719].pdf", "pdf bytes");
    put("C/Frank Herbert - Dune copy [9780441172719].pdf", "other pdf bytes");
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
    put("A/Frank Herbert - Dune.epub");
    let app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Frank Herbert - Dune.epub")!;
    await app.library.close();

    // Rename while the server is down: the hash still links it.
    mkdirSync(join(root, "B"));
    renameSync(join(root, "A/Frank Herbert - Dune.epub"), join(root, "B/renamed.epub"));
    app = newApp();
    await app.library.open(root);
    expect(bookIdOf(app, "B/renamed.epub")).toBe(id);
    expect(bookRepo.get(app.db, id)!.title).toBe("Dune");
  });
});

describe("retention on startup", () => {
  test("unconfirmed rows without files are deleted, confirmed rows are kept", async () => {
    put("A/Someone - Keep.epub");
    put("A/Someone - Drop.epub");
    let app = newApp();
    await app.library.open(root);
    const keep = bookIdOf(app, "A/Someone - Keep.epub")!;
    const drop = bookIdOf(app, "A/Someone - Drop.epub")!;
    app.db.query("UPDATE books SET confirmed_source = 'openlibrary' WHERE id = ?").run(keep);
    await app.library.close();

    rmSync(join(root, "A/Someone - Keep.epub"));
    rmSync(join(root, "A/Someone - Drop.epub"));
    put("A/Person - Other.epub"); // library is not empty
    app = newApp();
    await app.library.open(root);
    expect(bookRepo.exists(app.db, keep)).toBe(true);
    expect(bookRepo.exists(app.db, drop)).toBe(false);
    expect(list(app).items.map((b) => b.title)).toEqual(["Other"]);

    // The kept row reconnects when the file comes back.
    put("Elsewhere/whatever.epub", "A/Someone - Keep.epub"); // same bytes as before
    await app.library.rescan();
    expect(bookIdOf(app, "Elsewhere/whatever.epub")).toBe(keep);
  });

  test("an empty/unmounted library never purges metadata", async () => {
    put("A/Someone - Book.epub");
    let app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Someone - Book.epub")!;
    await app.library.close();

    rmSync(join(root, "A"), { recursive: true });
    app = newApp();
    await app.library.open(root);
    expect(bookRepo.exists(app.db, id)).toBe(true);
    expect(app.library.status().message).toMatch(/mounted/);

    await app.library.close();
    rmSync(root, { recursive: true });
    app = newApp();
    await app.library.open(root);
    expect(app.library.status().state).toBe("unavailable");
    expect(bookRepo.exists(app.db, id)).toBe(true);

    // Nothing polls: the library comes back with the next rescan.
    put("A/Someone - Book.epub");
    await app.library.rescan();
    expect(app.library.status().state).toBe("ready");
    expect(bookIdOf(app, "A/Someone - Book.epub")).toBe(id);
  });

  test("the empty-library warning clears once a rescan finds books", async () => {
    put("A/Someone - Book.epub");
    let app = newApp();
    await app.library.open(root);
    await app.library.close();

    rmSync(join(root, "A"), { recursive: true });
    app = newApp();
    await app.library.open(root);
    expect(app.library.status().message).toMatch(/mounted/);

    put("B/Author - New Book.epub");
    await app.library.rescan();
    expect(titles(app)).toContain("New Book");
    expect(app.library.status().message).toBeNull();
  });
});

describe("rescans", () => {
  test("changes made outside Bookshelf show up at the next rescan, not before", async () => {
    put("Shelf/Someone - Staying.epub"); // a scan that finds no files at all keeps everything (unmounted drive)
    const app = newApp();
    await app.library.open(root);
    put("Shelf/Author - New Book.epub");
    await Bun.sleep(100);
    expect(titles(app)).toEqual(["Staying"]);
    await app.library.rescan();
    expect(titles(app)).toEqual(["New Book", "Staying"]);
    const id = bookIdOf(app, "Shelf/Author - New Book.epub")!;

    rmSync(join(root, "Shelf/Author - New Book.epub"));
    await app.library.rescan();
    expect(app.library.index.hasBook(id)).toBe(false);
    expect(bookRepo.exists(app.db, id)).toBe(false); // unconfirmed: dropped with the file
  });

  test("confirmed metadata is kept after an external delete", async () => {
    put("Shelf/Author - Kept.epub");
    const app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "Shelf/Author - Kept.epub")!;
    app.db.query("UPDATE books SET confirmed_source = 'manual' WHERE id = ?").run(id);
    rmSync(join(root, "Shelf/Author - Kept.epub"));
    await app.library.rescan();
    expect(app.library.index.hasBook(id)).toBe(false);
    expect(bookRepo.exists(app.db, id)).toBe(true);
    expect(titles(app)).toEqual([]);
  });

  test("moving a file between shelves keeps its metadata", async () => {
    put("A/Author - Moved.epub");
    const app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, "A/Author - Moved.epub")!;
    mkdirSync(join(root, "B"));
    renameSync(join(root, "A/Author - Moved.epub"), join(root, "B/Author - Moved.epub"));
    await app.library.rescan();
    expect(bookIdOf(app, "B/Author - Moved.epub")).toBe(id);
    expect(app.library.index.get("A/Author - Moved.epub")).toBeUndefined();
    expect(bookRepo.exists(app.db, id)).toBe(true);
    expect(list(app, { shelf: "B" }).items.map((b) => b.id)).toEqual([id]);
  });

  test("renaming a shelf directory keeps every book", async () => {
    put("Old/A - One.epub");
    put("Old/Sub/B - Two.pdf");
    const app = newApp();
    await app.library.open(root);
    const ids = list(app).items.map((b) => b.id).sort();
    renameSync(join(root, "Old"), join(root, "New"));
    await app.library.rescan();
    expect(list(app, { shelf: "New" }).total).toBe(2);
    expect(list(app, { shelf: "Old" }).total).toBe(0);
    expect(list(app).items.map((b) => b.id).sort()).toEqual(ids);
    expect(ids.every((id) => bookRepo.exists(app.db, id))).toBe(true);
  });

  test("content change with the same ISBN stays the same book", async () => {
    const rel = "A/Frank Herbert - Dune [9780441172719].epub";
    put(rel, "v1");
    const app = newApp();
    await app.library.open(root);
    const id = bookIdOf(app, rel)!;
    const oldHash = app.library.index.get(rel)!.hash;
    writeFileSync(join(root, rel), "v2 with more bytes");
    await app.library.rescan();
    expect(app.library.index.get(rel)!.hash).not.toBe(oldHash);
    expect(bookIdOf(app, rel)).toBe(id);
    expect(bookRepo.exists(app.db, id)).toBe(true);
  });
});

describe("embedded metadata and covers", () => {
  async function epub(title: string, author: string, isbn: string, coverPng?: Uint8Array) {
    return makeEpub({
      metadataXml: `<dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:identifier>urn:isbn:${isbn}</dc:identifier>
        <dc:subject>Classic</dc:subject>`,
      manifestXml: `<item id="c" href="cover.png" media-type="image/png" properties="cover-image"/>`,
      files: { "cover.png": coverPng ?? (await makePng(300, 450)) },
    });
  }

  test("embedded metadata is used and the cover stored as it is; filename fills gaps", async () => {
    const png = await makePng(300, 450);
    put("Shelf/download (1).epub", await epub("Embedded Title", "Embedded Author", "9780441172719", png));
    put("Shelf/Some Body - Paper From Filename.pdf", makePdf());
    const app = newApp();
    await app.library.open(root);

    const e = list(app, { q: "Embedded" }).items[0]!;
    expect(e).toMatchObject({ title: "Embedded Title", authors: ["Embedded Author"], isbn13: "9780441172719", tags: ["Classic"], metadataSource: "embedded" });
    expect(bookRepo.get(app.db, e.id)!.hasCover).toBe(true);
    const cover = coverStore.find(app.config.coversDir, e.id)!;
    expect(cover.contentType).toBe("image/png");
    expect(readFileSync(cover.path).equals(png)).toBe(true);

    const p = list(app, { q: "Paper" }).items[0]!;
    expect(p).toMatchObject({ title: "Paper From Filename", authors: ["Some Body"], metadataSource: "filename" });
  });

  test("embedded values are taken as they are, even placeholder ones", async () => {
    put("Shelf/Some Body - Paper From Filename.pdf", makePdf({ info: { Title: "untitled", Author: "Administrator" } }));
    const app = newApp();
    await app.library.open(root);
    expect(list(app).items[0]).toMatchObject({ title: "untitled", authors: ["Administrator"], metadataSource: "embedded" });
  });

  test("a PDF with the same embedded ISBN is attached to the EPUB's book and covers are cleaned up with the row", async () => {
    put("A/x.epub", await epub("Dune", "Frank Herbert", "9780441172719"));
    put("B/y.pdf", makePdf({ info: { Title: "Dune (scan)", Keywords: "ISBN 9780441172719" } }));
    put("C/Someone - Staying.epub");
    const app = newApp();
    await app.library.open(root);
    const books = list(app).items.filter((b) => b.title !== "Staying");
    expect(books).toHaveLength(1);
    expect(books[0]!.files.map((f) => f.format).sort()).toEqual(["epub", "pdf"]);
    const id = books[0]!.id;
    expect(coverStore.exists(app.config.coversDir, id)).toBe(true);

    rmSync(join(root, "A/x.epub"));
    rmSync(join(root, "B/y.pdf"));
    await app.library.rescan();
    expect(bookRepo.exists(app.db, id)).toBe(false);
    expect(coverStore.exists(app.config.coversDir, id)).toBe(false);
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
    expect(bookRepo.get(app.db, id)!.hasCover).toBe(true);
    expect(coverStore.find(app.config.coversDir, id)!.contentType).toBe("image/jpeg"); // the rendered first page
    expect(bookRepo.get(app.db, id)).toMatchObject({ title: "Dune (scan)", authors: [], pages: 2 });

    put("A/book.epub", await epub("Dune", "Frank Herbert", "9780441172719"));
    await app.library.rescan();
    expect(bookRepo.get(app.db, id)).toMatchObject({ title: "Dune", authors: ["Frank Herbert"], pages: 2, tags: ["Classic"], metadataSource: "embedded" });
    expect(coverStore.find(app.config.coversDir, id)!.contentType).toBe("image/png"); // EPUB cover replaced the rendered page
    expect(list(app).items).toHaveLength(1);
  });

  test("confirmed metadata is never rewritten by an attached file", async () => {
    put("A/scan.pdf", makePdf({ info: { Title: "My Corrected Title", Keywords: "ISBN 9780441172719" } }));
    const app = newApp();
    await app.library.open(root);
    const id = list(app).items[0]!.id;
    app.db.query("UPDATE books SET confirmed_source = 'manual' WHERE id = ?").run(id);
    put("A/book.epub", await epub("Dune", "Frank Herbert", "9780441172719"));
    await app.library.rescan();
    expect(app.library.index.filesOfBook(id)).toHaveLength(2);
    expect(bookRepo.get(app.db, id)).toMatchObject({ title: "My Corrected Title", authors: [] });
  });
});

test("shelvesFrom: directories plus shelves still in the index, books counted once", () => {
  const file = (shelf: string | null, bookId: number) => ({ shelf, bookId }) as IndexedFile;
  const files = [file("B", 1), file("B", 1), file("B", 2), file(null, 3), file("Gone", 4)];
  expect(shelvesFrom(["b2", "B", "a"], files)).toEqual([
    { name: null, bookCount: 1 },
    { name: "a", bookCount: 0 },
    { name: "B", bookCount: 2 },
    { name: "b2", bookCount: 0 },
    { name: "Gone", bookCount: 1 },
  ]);
});
