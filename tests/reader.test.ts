import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { apiRoutes } from "../src/server/api/router.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { makePdf, makePng, makeZip } from "./fixtures.ts";

let tmp: string;
let root: string;
let app: AppContext;
let server: ReturnType<typeof Bun.serve>;

const PDF_NAME = "Ünïcode \"Quoted\" Title -- Author.pdf";
const pdfBytes = makePdf({ pages: 3 });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bookshelf-reader-"));
  root = join(tmp, "library");
  mkdirSync(join(root, "S"), { recursive: true });
  writeFileSync(join(root, "S", PDF_NAME), pdfBytes);
  writeFileSync(
    join(root, "S/Comic -- Artist.cbz"),
    makeZip({ "p10.png": await makePng(30, 40), "p2.png": await makePng(20, 30), "ComicInfo.xml": "<ComicInfo/>" }),
  );
  writeFileSync(join(root, "S/Text -- Writer.epub"), "not really an epub");
  app = createApp(loadConfig({ BOOKSHELF_DATA_DIR: join(tmp, "data") }));
  await app.library.open(root);
  server = Bun.serve({ port: 0, routes: apiRoutes(app) });
});

afterAll(async () => {
  server.stop(true);
  await app.library.close();
  app.db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fileOf = (rel: string) => app.library.index.get(rel)!;
const url = (path: string) => `${server.url}${path.slice(1)}`;

describe("file serving", () => {
  test("full GET, inline vs download disposition, UTF-8 filename, ETag/304", async () => {
    const f = fileOf(`S/${PDF_NAME}`);
    const res = await fetch(url(`/api/books/${f.bookId}/files/${f.hash}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="_n_code _Quoted_ Title -- Author.pdf"; filename*=UTF-8''${encodeURIComponent(PDF_NAME)}`,
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(pdfBytes))).toBe(true);

    const dl = await fetch(url(`/api/books/${f.bookId}/files/${f.hash}?download=1`));
    expect(dl.headers.get("content-disposition")).toStartWith("attachment;");
    await dl.arrayBuffer();

    const etag = res.headers.get("etag")!;
    expect(etag).toBe(`"${f.hash}"`);
    expect((await fetch(url(`/api/books/${f.bookId}/files/${f.hash}`), { headers: { "If-None-Match": etag } })).status).toBe(304);
  });

  test("byte ranges", async () => {
    const f = fileOf(`S/${PDF_NAME}`);
    const get = (range: string, extra: Record<string, string> = {}) =>
      fetch(url(`/api/books/${f.bookId}/files/${f.hash}`), { headers: { Range: range, ...extra } });
    const size = pdfBytes.length;

    const first = await get("bytes=0-4");
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-4/${size}`);
    expect(await first.text()).toBe("%PDF-");

    const suffix = await get("bytes=-6");
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 6}-${size - 1}/${size}`);
    expect(await suffix.text()).toBe("%%EOF\n");

    const open = await get(`bytes=${size - 2}-`);
    expect(open.headers.get("content-range")).toBe(`bytes ${size - 2}-${size - 1}/${size}`);
    await open.arrayBuffer();

    const clamped = await get(`bytes=${size - 2}-99999999`);
    expect(clamped.headers.get("content-length")).toBe("2");
    await clamped.arrayBuffer();

    expect((await get(`bytes=${size}-`)).status).toBe(416);
    expect((await get("bytes=5-2")).status).toBe(416);
    expect((await get("lines=1-2")).status).toBe(416);
    const stale = await get("bytes=0-4", { "If-Range": '"other"' });
    expect(stale.status).toBe(200); // validator mismatch → full body
    await stale.arrayBuffer();
  });

  test("HEAD, wrong hash/book", async () => {
    const f = fileOf(`S/${PDF_NAME}`);
    const head = await fetch(url(`/api/books/${f.bookId}/files/${f.hash}`), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(pdfBytes.length));
    expect((await fetch(url(`/api/books/${f.bookId}/files/deadbeef`))).status).toBe(404);
    const other = fileOf("S/Comic -- Artist.cbz");
    expect((await fetch(url(`/api/books/${other.bookId}/files/${f.hash}`))).status).toBe(404);
  });
});

describe("page images", () => {
  test("CBZ pages in natural order, out-of-range and wrong format", async () => {
    const f = fileOf("S/Comic -- Artist.cbz");
    const base = `/api/books/${f.bookId}/files/${f.hash}/pages`;
    expect(await (await fetch(url(base))).json()).toEqual({ count: 2 });
    const p1 = await fetch(url(`${base}/1`));
    expect(p1.headers.get("content-type")).toBe("image/png");
    expect(p1.headers.get("cache-control")).toContain("immutable");
    const meta = await sharp(new Uint8Array(await p1.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([20, 30]); // p2 before p10
    expect((await fetch(url(`${base}/3`))).status).toBe(404);
    expect((await fetch(url(`${base}/0`))).status).toBe(404);
    const epub = fileOf("S/Text -- Writer.epub");
    expect((await fetch(url(`/api/books/${epub.bookId}/files/${epub.hash}/pages`))).status).toBe(400);
  });

  test.skipIf(!Bun.which("7z"))("CBR (7z archive) pages", async () => {
    const dir = mkdtempSync(join(tmp, "cbr-"));
    writeFileSync(join(dir, "01.png"), await makePng(11, 12));
    writeFileSync(join(dir, "02.png"), await makePng(13, 14));
    Bun.spawnSync(["7z", "a", "-t7z", join(root, "S/Rar Comic -- X.cbr"), "."], { cwd: dir, stdout: "ignore" });
    await app.library.rescan();
    const f = fileOf("S/Rar Comic -- X.cbr");
    expect(await app.reader.pageCount(f.bookId, f.hash)).toBe(2);
    const p2 = await app.reader.page(f.bookId, f.hash, 2);
    expect((await sharp(p2.data).metadata()).width).toBe(13);
  });

  test.skipIf(!Bun.which("c44") || !Bun.which("ddjvu") || !Bun.which("pdftoppm"))("DJVU pages rendered to JPEG", async () => {
    const dir = mkdtempSync(join(tmp, "djvu-"));
    writeFileSync(join(dir, "p.pdf"), makePdf());
    Bun.spawnSync(["pdftoppm", "-singlefile", "p.pdf", "page"], { cwd: dir });
    Bun.spawnSync(["c44", "page.ppm", join(root, "S/Scan -- Y.djvu")], { cwd: dir });
    await app.library.rescan();
    const f = fileOf("S/Scan -- Y.djvu");
    expect(await app.reader.pageCount(f.bookId, f.hash)).toBe(1);
    const p = await app.reader.page(f.bookId, f.hash, 1);
    expect(p.mime).toBe("image/jpeg");
    expect((await sharp(p.data).metadata()).format).toBe("jpeg");
  });
});

describe("reading position", () => {
  test("saved per book, exposed as progress, does not confirm or touch updated_at", async () => {
    const f = fileOf("S/Comic -- Artist.cbz");
    const before = app.books.get(f.bookId)!;
    const put = (body: unknown) =>
      fetch(url(`/api/books/${f.bookId}/position`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ hash: f.hash, position: "2", fraction: 1.7 })).status).toBe(200);
    const detail = await (await fetch(url(`/api/books/${f.bookId}`))).json();
    expect(detail.readingPosition).toMatchObject({ hash: f.hash, position: "2", fraction: 1 });
    expect(detail.confirmedSource).toBeNull();
    expect(app.books.get(f.bookId)!.updatedAt).toBe(before.updatedAt);
    const list = await (await fetch(url(`/api/library?q=Comic`))).json();
    expect(list.items[0].progress).toBe(1);
    expect((await put({ hash: "nope", position: "1" })).status).toBe(404);
    expect((await put({ position: "1" })).status).toBe(400);
  });
});

describe("pdf.js assets", () => {
  test("worker, cmaps and fonts are served; nothing else", async () => {
    const worker = await fetch(url("/vendor/pdfjs/build/pdf.worker.min.mjs"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toBe("text/javascript");
    await worker.arrayBuffer();
    expect((await fetch(url("/vendor/pdfjs/cmaps/78-H.bcmap"))).status).toBe(200);
    expect((await fetch(url("/vendor/pdfjs/standard_fonts/FoxitFixed.pfb"))).status).toBe(200);
    expect((await fetch(url("/vendor/pdfjs/build/pdf.mjs"))).status).toBe(404);
    expect((await fetch(url("/vendor/pdfjs/cmaps/..%2F..%2Fpackage.json"))).status).toBe(404);
    expect((await fetch(url("/vendor/pdfjs/other/x"))).status).toBe(404);
  });
});
