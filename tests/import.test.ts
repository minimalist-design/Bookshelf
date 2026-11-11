import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { ValidationError } from "../src/server/library/paths.ts";
import { listLibrary } from "../src/server/library/queries.ts";
import { makeEpub, makePdf, makePng } from "./fixtures.ts";

const FAST = { debounceMs: 30, stableMs: 80, graceMs: 300 };
let tmp: string;
let root: string;
let app: AppContext;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bookshelf-import-"));
  root = join(tmp, "library");
  mkdirSync(join(root, "Fiction"), { recursive: true });
  mkdirSync(join(root, "Science"), { recursive: true });
  app = createApp(loadConfig({ BOOKSHELF_DATA_DIR: join(tmp, "data"), BOOKSHELF_MAX_UPLOAD_MB: "1" }), { library: FAST });
  await app.library.open(root);
});

afterEach(async () => {
  await app.library.close();
  app.db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const stream = (data: Uint8Array | string) => new Response(new Blob([data as BlobPart])).body;
const upload = (data: Uint8Array | string, name: string, shelf: string | null = null) =>
  app.importer.importStream(stream(data), name, shelf);
const books = () => listLibrary(app.library.index, app.books, {}).items;
const incomingEmpty = () => !existsSync(join(root, ".bookshelf-incoming"));

async function epub(title: string, authors: string[], isbn?: string, withCover = true) {
  return makeEpub({
    metadataXml: `<dc:title>${title}</dc:title>${authors.map((a) => `<dc:creator>${a}</dc:creator>`).join("")}
      ${isbn ? `<dc:identifier>urn:isbn:${isbn}</dc:identifier>` : ""}`,
    manifestXml: withCover ? `<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>` : "",
    files: withCover ? { "c.png": await makePng(120, 180) } : {},
  });
}

describe("import", () => {
  test("embedded metadata names the file; it lands in the chosen shelf with a cover", async () => {
    const r = await upload(await epub("Dune", ["Frank Herbert"], "9780441172719"), "random download name.epub", "Fiction");
    expect(r).toMatchObject({ status: "imported", title: "Dune", authors: ["Frank Herbert"], shelf: "Fiction", format: "epub" });
    expect(r.relPath).toBe("Fiction/Frank Herbert - Dune [9780441172719].epub");
    expect(existsSync(join(root, r.relPath!))).toBe(true);
    expect(app.books.get(r.bookId)!.hasCover).toBe(true);
    expect(incomingEmpty()).toBe(true);
  });

  test("filename pattern metadata, uppercase extension normalized, Unshelved", async () => {
    const r = await upload(makePdf(), "Attention Is All You Need -- Vaswani, Ashish; Shazeer, Noam; Parmar, Niki -- doi 10.48550_arXiv.1706.03762.PDF", null);
    expect(r.status).toBe("imported");
    expect(r.relPath).toBe("Ashish Vaswani et al. - Attention Is All You Need [10.48550_arXiv.1706.03762].pdf");
    expect(app.books.get(r.bookId)).toMatchObject({ doi: "10.48550/arXiv.1706.03762", authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"] });
  });

  test("exact duplicate is rejected and nothing is written", async () => {
    const data = await epub("Dune", ["Frank Herbert"], "9780441172719");
    const first = await upload(data, "a.epub", "Fiction");
    const second = await upload(data, "b.epub", "Science");
    expect(second).toMatchObject({ status: "duplicate", bookId: first.bookId, relPath: first.relPath });
    expect(readdirSync(join(root, "Science"))).toEqual([]);
    expect(incomingEmpty()).toBe(true);
  });

  test("same identifier and format with different bytes is a duplicate", async () => {
    const first = await upload(await epub("Dune", ["Frank Herbert"], "9780441172719"), "a.epub", "Fiction");
    const second = await upload(await epub("Dune (other edition)", ["F. Herbert"], "9780441172719", false), "b.epub", "Science");
    expect(second).toMatchObject({ status: "duplicate", bookId: first.bookId });
    expect(books()).toHaveLength(1);
  });

  test("same identifier in another format is attached next to the existing file, sharing its name", async () => {
    const first = await upload(await epub("Dune", ["Frank Herbert"], "9780441172719"), "a.epub", "Fiction");
    const r = await upload(makePdf({ info: { Title: "scan", Keywords: "ISBN 9780441172719" } }), "dune.pdf", "Science");
    expect(r).toMatchObject({ status: "attached", bookId: first.bookId, shelf: "Fiction" });
    expect(r.relPath).toBe("Fiction/Frank Herbert - Dune [9780441172719].pdf");
    const all = books();
    expect(all).toHaveLength(1);
    expect(all[0]!.files.map((f) => f.format).sort()).toEqual(["epub", "pdf"]);
    expect(all[0]!.title).toBe("Dune"); // EPUB metadata outranks the PDF's
  });

  test("confirmed metadata without files is reconnected by content or identifier", async () => {
    const data = await epub("Dune", ["Frank Herbert"], "9780441172719");
    const first = await upload(data, "a.epub", "Fiction");
    app.db.query("UPDATE books SET confirmed_source = 'openlibrary', title = 'Dune (verified)' WHERE id = ?").run(first.bookId);
    rmSync(join(root, first.relPath!));
    await Bun.sleep(FAST.graceMs + 300);
    expect(app.books.exists(first.bookId)).toBe(true);
    expect(books()).toHaveLength(0);

    const again = await upload(data, "again.epub", "Science");
    expect(again).toMatchObject({ status: "reconnected", bookId: first.bookId, title: "Dune (verified)", shelf: "Science" });
    expect(again.relPath).toBe("Science/Frank Herbert - Dune (verified) [9780441172719].epub");

    rmSync(join(root, again.relPath!));
    await Bun.sleep(FAST.graceMs + 300);
    const byId = await upload(makePdf({ info: { Keywords: "ISBN 9780441172719" } }), "other.pdf", "Fiction");
    expect(byId).toMatchObject({ status: "reconnected", bookId: first.bookId, shelf: "Fiction" });
  });

  test("name collisions get a counter", async () => {
    const a = await upload(await epub("Same Title", ["Same Author"], undefined, false), "1.epub", "Fiction");
    const b = await upload(await epubVariant(), "2.epub", "Fiction");
    expect(a.relPath).toBe("Fiction/Same Author - Same Title.epub");
    expect(b.relPath).toBe("Fiction/Same Author - Same Title (2).epub");
    expect(books()).toHaveLength(2);
  });

  test("watcher does not process imported files a second time", async () => {
    await upload(await epub("Dune", ["Frank Herbert"], "9780441172719"), "a.epub", "Fiction");
    await upload(makePdf(), "Paper -- Someone.pdf", "Science");
    await Bun.sleep(600);
    expect(app.library.index.size).toBe(2);
    expect(app.books.count()).toBe(2);
  });

  test("validation: unsupported type, unknown or invalid shelf, empty file, size limit", async () => {
    await expect(upload("x", "notes.txt", null)).rejects.toThrow(ValidationError);
    await expect(upload(makePdf(), "a.pdf", "Nope")).rejects.toThrow(/does not exist/);
    await expect(upload(makePdf(), "a.pdf", "../etc")).rejects.toThrow(ValidationError);
    await expect(upload(new Uint8Array(), "a.pdf", null)).rejects.toThrow(/empty/);
    await expect(upload(new Uint8Array(1.5 * 1024 * 1024), "big.pdf", null)).rejects.toThrow(/limit/);
    expect(incomingEmpty()).toBe(true);
    expect(books()).toHaveLength(0);
  });
});

/** An EPUB with the same metadata but different bytes (different cover). */
async function epubVariant() {
  return makeEpub({
    metadataXml: `<dc:title>Same Title</dc:title><dc:creator>Same Author</dc:creator><dc:description>variant</dc:description>`,
  });
}

describe("HTTP endpoint", () => {
  test("status codes per outcome", async () => {
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const post = (data: Uint8Array, filename: string, shelf?: string) =>
        fetch(`${server.url}api/import?${new URLSearchParams({ filename, ...(shelf !== undefined ? { shelf } : {}) })}`, { method: "POST", body: new Blob([data as BlobPart]) });
      const data = await epub("Dune", ["Frank Herbert"], "9780441172719");
      const created = await post(data, "dune.epub", "Fiction");
      expect(created.status).toBe(201);
      expect((await created.json()).relPath).toBe("Fiction/Frank Herbert - Dune [9780441172719].epub");
      expect((await post(data, "dune.epub")).status).toBe(409);
      expect((await post(makePdf({ info: { Keywords: "ISBN 9780441172719" } }), "dune.pdf")).status).toBe(200);
      const bad = await post(makePdf(), "x.txt");
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toMatch(/Unsupported/);
    } finally {
      server.stop(true);
    }
  });
});
