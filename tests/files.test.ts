import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notFound } from "../src/server/api/http.ts";
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
  tmp = mkdtempSync(join(tmpdir(), "bookshelf-files-"));
  root = join(tmp, "library");
  mkdirSync(join(root, "S"), { recursive: true });
  writeFileSync(join(root, "S", PDF_NAME), pdfBytes);
  writeFileSync(
    join(root, "S/Comic -- Artist.cbz"),
    makeZip({ "p10.png": await makePng(30, 40), "p2.png": await makePng(20, 30), "ComicInfo.xml": "<ComicInfo/>" }),
  );
  writeFileSync(join(root, "S/Text -- Writer.epub"), "not really an epub");
  app = createApp(loadConfig({ data_dir: join(tmp, "data") }));
  await app.library.open(root);
  server = Bun.serve({ port: 0, routes: apiRoutes(app), fetch: notFound });
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

describe("outside the API", () => {
  test("removed reader routes, pdf.js assets and non-API paths answer a JSON 404", async () => {
    const f = fileOf("S/Comic -- Artist.cbz");
    for (const path of [
      `/api/books/${f.bookId}/files/${f.hash}/pages`,
      `/api/books/${f.bookId}/files/${f.hash}/pages/1`,
      "/api/fs/browse",
      "/vendor/pdfjs/build/pdf.worker.min.mjs",
      "/",
      "/library",
    ]) {
      const res = await fetch(url(path));
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    const put = await fetch(url(`/api/books/${f.bookId}/position`), { method: "PUT", body: "{}" });
    expect(put.status).toBe(404);
  });
});
