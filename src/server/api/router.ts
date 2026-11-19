import type { AppContext } from "../app.ts";
import type { ApplyMetadataRequest, BookUpdate, LookupSource, SettingsUpdate } from "../../shared/types.ts";
import { ValidationError } from "../library/paths.ts";
import { browseDirectories, makeDirectory } from "./fsBrowse.ts";
import { health } from "./health.ts";
import { handle, json, readJson } from "./http.ts";
import { bookDetail, coverResponse, facets, libraryPage, shelves } from "./library.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { CONTENT_TYPES, contentDisposition, serveFile } from "./files.ts";
import { pdfjsAssetPath } from "./pdfjsAssets.ts";

export function apiRoutes(app: AppContext) {
  return {
    "/api/health": { GET: () => health(app), HEAD: () => health(app) },
    "/api/settings": {
      GET: handle(() => json(getSettings(app))),
      PUT: handle(async (req) => json(updateSettings(app, await readJson<SettingsUpdate>(req)))),
    },
    "/api/fs/browse": {
      GET: handle((req) => json(browseDirectories(new URL(req.url).searchParams.get("path")))),
    },
    "/api/fs/mkdir": {
      POST: handle(async (req) => {
        const body = await readJson<{ parent: unknown; name: unknown }>(req);
        return json(makeDirectory(body.parent, body.name), { status: 201 });
      }),
    },
    "/api/library": { GET: handle((req) => json(libraryPage(app, new URL(req.url)))) },
    "/api/library/status": { GET: () => json(app.library.status()) },
    "/api/library/rescan": {
      POST: handle(() => {
        void app.library.rescan();
        return json(app.library.status(), { status: 202 });
      }),
    },
    "/api/shelves": {
      GET: handle(() => json(shelves(app))),
      POST: handle(async (req) => {
        const name = await app.shelfService.create(nameOf(await readJson<{ name: unknown }>(req)));
        return json({ name, bookCount: 0 }, { status: 201 });
      }),
    },
    "/api/shelves/:name": {
      PATCH: handle(async (req: Bun.BunRequest<"/api/shelves/:name">) => {
        const name = await app.shelfService.rename(req.params.name, nameOf(await readJson<{ name: unknown }>(req)));
        return json(shelves(app).find((s) => s.name === name) ?? { name, bookCount: 0 });
      }),
      DELETE: handle(async (req: Bun.BunRequest<"/api/shelves/:name">) => json(await app.shelfService.remove(req.params.name))),
    },
    "/api/books/move": {
      POST: handle(async (req) => {
        const body = await readJson<{ ids: unknown; shelf: unknown }>(req);
        if (body.shelf !== null && typeof body.shelf !== "string") throw new ValidationError("shelf must be a name or null");
        return json(await app.bookService.move(idList(body.ids), body.shelf));
      }),
    },
    "/api/books/delete": {
      POST: handle(async (req) => json(await app.bookService.deleteBooks(idList((await readJson<{ ids: unknown }>(req)).ids)))),
    },
    "/api/books/:id/files/:hash": {
      GET: handle((req: Bun.BunRequest<"/api/books/:id/files/:hash">) => bookFile(app, req)),
      HEAD: handle((req: Bun.BunRequest<"/api/books/:id/files/:hash">) => bookFile(app, req)),
      DELETE: handle(async (req: Bun.BunRequest<"/api/books/:id/files/:hash">) =>
        json(await app.bookService.deleteFile(Number(req.params.id), req.params.hash)),
      ),
    },
    "/api/facets": { GET: handle(() => json(facets(app))) },
    "/api/books/normalize-filenames": {
      POST: handle(async (req) => json(await app.bookService.normalizeFilenames(idList((await readJson<{ ids: unknown }>(req)).ids)))),
    },
    "/api/books/:id": {
      GET: handle((req: Bun.BunRequest<"/api/books/:id">) => json(bookDetail(app, Number(req.params.id)))),
      PATCH: handle(async (req: Bun.BunRequest<"/api/books/:id">) =>
        json(await app.bookService.update(Number(req.params.id), await readJson<BookUpdate>(req))),
      ),
      DELETE: handle(async (req: Bun.BunRequest<"/api/books/:id">) => {
        bookDetail(app, Number(req.params.id)); // 404 unless on disk
        return json(await app.bookService.deleteBooks([Number(req.params.id)]));
      }),
    },
    "/api/books/:id/normalize-filename": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/normalize-filename">) =>
        json(await app.bookService.normalizeFilenames([Number(req.params.id)])),
      ),
    },
    "/api/books/:id/merge": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/merge">) => {
        const { intoId } = await readJson<{ intoId: unknown }>(req);
        return json(await app.bookService.merge(Number(req.params.id), idList([intoId])[0]!));
      }),
    },
    "/api/books/:id/files/:hash/detach": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/files/:hash/detach">) =>
        json(await app.bookService.detach(Number(req.params.id), req.params.hash)),
      ),
    },
    "/api/books/:id/cover": {
      GET: handle((req: Bun.BunRequest<"/api/books/:id/cover">) =>
        coverResponse(app, Number(req.params.id), new URL(req.url).searchParams.get("size"), req),
      ),
      PUT: handle(async (req: Bun.BunRequest<"/api/books/:id/cover">) => {
        const data = await req.bytes();
        if (data.byteLength > 50 * 1024 * 1024) throw new ValidationError("Image is too large (max 50 MB)");
        await app.bookService.setCover(Number(req.params.id), data);
        return json(bookDetail(app, Number(req.params.id)));
      }),
      DELETE: handle(async (req: Bun.BunRequest<"/api/books/:id/cover">) => {
        await app.bookService.removeCover(Number(req.params.id));
        return json(bookDetail(app, Number(req.params.id)));
      }),
    },
    // Raw file body (streamed); ?filename=<original name>&shelf=<name> (omitted/empty = Unshelved).
    "/api/import": {
      POST: handle(async (req) => {
        const url = new URL(req.url);
        const result = await app.importer.importStream(req.body, url.searchParams.get("filename") ?? "", url.searchParams.get("shelf"));
        const status = result.status === "duplicate" ? 409 : result.status === "attached" ? 200 : 201;
        return json(result, { status });
      }),
    },
    "/api/books/:id/files/:hash/pages": {
      GET: handle(async (req: Bun.BunRequest<"/api/books/:id/files/:hash/pages">) =>
        json({ count: await app.reader.pageCount(Number(req.params.id), req.params.hash) }),
      ),
    },
    "/api/books/:id/files/:hash/pages/:n": {
      GET: handle(async (req: Bun.BunRequest<"/api/books/:id/files/:hash/pages/:n">) => {
        const { id, hash, n } = req.params;
        const img = await app.reader.page(Number(id), hash, Number(n));
        // The URL contains the content hash, so a page never changes.
        return new Response(img.data as BodyInit & Uint8Array, { headers: { "Content-Type": img.mime, "Cache-Control": "private, max-age=31536000, immutable" } });
      }),
    },
    "/api/books/:id/position": {
      PUT: handle(async (req: Bun.BunRequest<"/api/books/:id/position">) =>
        json(app.reader.savePosition(Number(req.params.id), await readJson(req))),
      ),
    },
    "/vendor/pdfjs/:kind/:name": {
      GET: handle((req: Bun.BunRequest<"/vendor/pdfjs/:kind/:name">) => pdfjsAsset(req)),
    },
    "/api/maintenance/stats": { GET: handle(() => json(app.maintenance.stats())) },
    "/api/maintenance/missing": {
      GET: handle(async () => json(await app.maintenance.missing())),
      // Forget (permanently delete) metadata of books without files.
      POST: handle(async (req) => json(await app.maintenance.forget(idList((await readJson<{ ids: unknown }>(req)).ids)))),
    },
    "/api/maintenance/cleanup": { POST: handle(async () => json(await app.maintenance.cleanup())) },
    "/api/maintenance/normalize": {
      POST: handle(async (req) => {
        const { shelf } = await readJson<{ shelf?: unknown }>(req);
        if (shelf !== undefined && shelf !== null && typeof shelf !== "string") throw new ValidationError("shelf must be a name, \"\" or null");
        return json(await app.maintenance.normalize(shelf as string | null | undefined));
      }),
    },
    "/api/maintenance/http-cache": { DELETE: handle(() => json({ removed: app.maintenance.clearHttpCache() })) },
    "/api/lookup/status": { GET: handle(() => json(app.lookup.status())) },
    "/api/lookup/bulk": {
      POST: handle(async (req) => json(app.lookup.enqueue(idList((await readJson<{ ids: unknown }>(req)).ids)), { status: 202 })),
    },
    "/api/lookup/cancel": { POST: handle(() => json(app.lookup.cancel())) },
    "/api/lookup/retry-failed": { POST: handle(() => json(app.lookup.retryFailed(), { status: 202 })) },
    "/api/lookup/:id": {
      GET: handle(async (req: Bun.BunRequest<"/api/lookup/:id">) => {
        const p = new URL(req.url).searchParams;
        const source = p.get("source");
        if (source && source !== "openlibrary" && source !== "doi") throw new ValidationError("source must be openlibrary or doi");
        return json(await app.lookup.lookup(Number(req.params.id), { source: (source as LookupSource) || undefined, q: p.get("q") || undefined }));
      }),
    },
    "/api/lookup/:id/covers": {
      GET: handle(async (req: Bun.BunRequest<"/api/lookup/:id/covers">) =>
        json(await app.lookup.findCovers(Number(req.params.id), new URL(req.url).searchParams.get("q") || undefined)),
      ),
    },
    "/api/books/:id/cover/from-url": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/cover/from-url">) => {
        const { url } = await readJson<{ url: unknown }>(req);
        await app.lookup.setCoverFromUrl(Number(req.params.id), url);
        return json(bookDetail(app, Number(req.params.id)));
      }),
    },
    "/api/books/:id/apply-metadata": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/apply-metadata">) =>
        json(await app.lookup.apply(Number(req.params.id), await readJson<ApplyMetadataRequest>(req))),
      ),
    },
    "/api/review-queue": { GET: handle(() => json(app.lookup.reviewQueue())) },
    "/api/review-queue/accept-fills": { POST: handle(async () => json(await app.lookup.acceptAllFills())) },
    "/api/review-queue/:id": {
      DELETE: handle((req: Bun.BunRequest<"/api/review-queue/:id">) => {
        app.lookup.removeFromQueue(Number(req.params.id));
        return json(app.lookup.status());
      }),
    },
    "/api/*": () => json({ error: "Not found" }, { status: 404 }),
  } as const;
}

function idList(v: unknown): number[] {
  if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || (x as number) <= 0)) {
    throw new ValidationError("Expected a list of book ids");
  }
  return v as number[];
}

function nameOf(body: { name: unknown }): string {
  if (typeof body?.name !== "string") throw new ValidationError("name is required");
  return body.name;
}

function bookFile(app: AppContext, req: Bun.BunRequest<"/api/books/:id/files/:hash">): Response {
  const { abs, file } = app.reader.file(Number(req.params.id), req.params.hash);
  const download = new URL(req.url).searchParams.has("download");
  return serveFile(req, abs, {
    contentType: file.filename.toLowerCase().endsWith(".zip") || file.filename.toLowerCase().endsWith(".fbz") ? "application/zip" : CONTENT_TYPES[file.format],
    etag: file.hash,
    disposition: contentDisposition(download ? "attachment" : "inline", file.filename),
  });
}

/** pdf.js worker, CMaps, fonts, image decoders and ICC profiles for the browser PDF reader (allow-listed names only). */
function pdfjsAsset(req: Bun.BunRequest<"/vendor/pdfjs/:kind/:name">): Response {
  const { kind, name } = req.params;
  const path = pdfjsAssetPath(kind, name);
  if (!path) return json({ error: "Not found" }, { status: 404 });
  // application/wasm is required for WebAssembly.instantiateStreaming.
  const contentType = /\.m?js$/.test(name) ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return serveFile(req, path, { contentType, etag: `pdfjs-${name}`, cacheControl: "public, max-age=86400" });
}
