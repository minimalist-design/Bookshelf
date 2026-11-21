import type { AppContext } from "../app.ts";
import { LOOKUP_SOURCES, type ApplyMetadataRequest, type BookUpdate, type LookupSource, type SettingsUpdate } from "../../shared/types.ts";
import { ValidationError } from "../library/paths.ts";
import { handle, json, notFound, readJson } from "./http.ts";
import { bookDetail, coverResponse, facets, libraryPage, shelfList } from "./library.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { CONTENT_TYPES, contentDisposition, serveFile } from "./files.ts";
import * as referenceStore from "../reference/store.ts";
import * as lookups from "../services/lookup/lookup.ts";
import * as books from "../services/books.ts";
import * as shelves from "../services/shelves.ts";

export function apiRoutes(app: AppContext) {
  return {
    "/api/health": { GET: () => app.health(), HEAD: () => app.health() },
    "/api/settings": {
      GET: handle(() => json(getSettings(app))),
      PUT: handle(async (req) => json(updateSettings(app, await readJson<SettingsUpdate>(req)))),
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
      GET: handle(() => json(shelfList(app))),
      POST: handle(async (req) => {
        const name = await shelves.create(app, nameOf(await readJson<{ name: unknown }>(req)));
        return json({ name, bookCount: 0 }, { status: 201 });
      }),
    },
    "/api/shelves/:name": {
      PATCH: handle(async (req: Bun.BunRequest<"/api/shelves/:name">) => {
        const name = await shelves.rename(app, req.params.name, nameOf(await readJson<{ name: unknown }>(req)));
        return json(shelfList(app).find((s) => s.name === name) ?? { name, bookCount: 0 });
      }),
      DELETE: handle(async (req: Bun.BunRequest<"/api/shelves/:name">) => json(await shelves.remove(app, req.params.name))),
    },
    "/api/books/move": {
      POST: handle(async (req) => {
        const body = await readJson<{ ids: unknown; shelf: unknown }>(req);
        if (body.shelf !== null && typeof body.shelf !== "string") throw new ValidationError("shelf must be a name or null");
        return json(await books.move(app, idList(body.ids), body.shelf));
      }),
    },
    "/api/books/delete": {
      POST: handle(async (req) => json(await books.remove(app, idList((await readJson<{ ids: unknown }>(req)).ids)))),
    },
    "/api/books/:id/files/:hash": {
      GET: handle((req: Bun.BunRequest<"/api/books/:id/files/:hash">) => bookFile(app, req)),
      HEAD: handle((req: Bun.BunRequest<"/api/books/:id/files/:hash">) => bookFile(app, req)),
      DELETE: handle(async (req: Bun.BunRequest<"/api/books/:id/files/:hash">) =>
        json(await books.removeFile(app, Number(req.params.id), req.params.hash)),
      ),
    },
    "/api/facets": { GET: handle(() => json(facets(app))) },
    "/api/books/normalize-filenames": {
      POST: handle(async (req) => json(await books.normalizeFilenames(app, idList((await readJson<{ ids: unknown }>(req)).ids)))),
    },
    "/api/books/:id": {
      GET: handle((req: Bun.BunRequest<"/api/books/:id">) => json(bookDetail(app, Number(req.params.id)))),
      PATCH: handle(async (req: Bun.BunRequest<"/api/books/:id">) =>
        json(await books.update(app, Number(req.params.id), await readJson<BookUpdate>(req))),
      ),
      DELETE: handle(async (req: Bun.BunRequest<"/api/books/:id">) => {
        bookDetail(app, Number(req.params.id)); // 404 unless on disk
        return json(await books.remove(app, [Number(req.params.id)]));
      }),
    },
    "/api/books/:id/normalize-filename": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/normalize-filename">) =>
        json(await books.normalizeFilenames(app, [Number(req.params.id)])),
      ),
    },
    "/api/books/:id/cover": {
      GET: handle((req: Bun.BunRequest<"/api/books/:id/cover">) =>
        coverResponse(app, Number(req.params.id), req),
      ),
      PUT: handle(async (req: Bun.BunRequest<"/api/books/:id/cover">) => {
        const data = await req.bytes();
        if (data.byteLength > 50 * 1024 * 1024) throw new ValidationError("Image is too large (max 50 MB)");
        await books.setCover(app, Number(req.params.id), data);
        return json(bookDetail(app, Number(req.params.id)));
      }),
      DELETE: handle(async (req: Bun.BunRequest<"/api/books/:id/cover">) => {
        await books.removeCover(app, Number(req.params.id));
        return json(bookDetail(app, Number(req.params.id)));
      }),
    },
    // Raw file body (streamed); ?filename=<original name>&shelf=<name> (omitted/empty = Unshelved)
    // &lookup=1 to queue a metadata lookup when the upload creates a new book.
    "/api/import": {
      POST: handle(async (req) => {
        const url = new URL(req.url);
        const imported = await app.importer.importStream(req.body, url.searchParams.get("filename") ?? "", url.searchParams.get("shelf"));
        const queue = imported.status === "imported" && url.searchParams.get("lookup") === "1";
        if (queue) app.lookup.enqueue([imported.bookId]);
        const status = imported.status === "duplicate" ? 409 : imported.status === "attached" ? 200 : 201;
        return json(queue ? { ...imported, lookupQueued: true } : imported, { status });
      }),
    },
    // Reference data: GET lists the imported files; POST imports the request body (raw file, ?name=<file name>).
    "/api/reference": {
      GET: handle(() => json(referenceStore.list(app.config.referenceDir))),
      POST: handle(async (req) => json(await referenceStore.importUpload(app.config.referenceDir, req.body, new URL(req.url).searchParams.get("name") ?? "", app.config.maxUploadBytes), { status: 201 })),
    },
    "/api/reference/from-file": {
      POST: handle(async (req) => {
        const { path } = await readJson<{ path?: unknown }>(req);
        if (typeof path !== "string") throw new ValidationError("path must be a file path on the server");
        return json(await referenceStore.importFile(app.config.referenceDir, path), { status: 201 });
      }),
    },
    "/api/reference/:source": {
      DELETE: handle((req: Bun.BunRequest<"/api/reference/:source">) => {
        referenceStore.remove(app.config.referenceDir, req.params.source);
        return json({ removed: req.params.source });
      }),
    },
    "/api/lookup/status": { GET: handle(() => json(app.lookup.status())) },
    "/api/lookup/bulk": {
      POST: handle(async (req) => json(app.lookup.enqueue(idList((await readJson<{ ids: unknown }>(req)).ids)), { status: 202 })),
    },
    "/api/lookup/jobs": {
      GET: handle((req) => json(app.lookup.jobs(idList((new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number))))),
    },
    "/api/metadata-usage": {
      GET: handle((req) => {
        const since = Number(new URL(req.url).searchParams.get("since"));
        return json(app.http.usage(Number.isFinite(since) && since > 0 ? since : Date.now()));
      }),
    },
    "/api/isbndb/key": { GET: handle(async () => json(await lookups.isbndbKey(app))) },
    "/api/lookup/cancel": { POST: handle(() => json(app.lookup.cancel())) },
    "/api/lookup/retry-failed": { POST: handle(() => json(app.lookup.retryFailed(), { status: 202 })) },
    "/api/lookup/:id": {
      GET: handle(async (req: Bun.BunRequest<"/api/lookup/:id">) => {
        const p = new URL(req.url).searchParams;
        const source = p.get("source");
        if (source && !(LOOKUP_SOURCES as readonly string[]).includes(source)) throw new ValidationError(`source must be one of ${LOOKUP_SOURCES.join(", ")}`);
        return json(await lookups.find(app, Number(req.params.id), { source: (source as LookupSource) || undefined, q: p.get("q") || undefined }));
      }),
    },
    "/api/lookup/:id/covers": {
      GET: handle(async (req: Bun.BunRequest<"/api/lookup/:id/covers">) =>
        json(await lookups.findCovers(app, Number(req.params.id), new URL(req.url).searchParams.get("q") || undefined)),
      ),
    },
    "/api/books/:id/cover/from-url": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/cover/from-url">) => {
        const { url } = await readJson<{ url: unknown }>(req);
        await lookups.setCoverFromUrl(app, Number(req.params.id), url);
        return json(bookDetail(app, Number(req.params.id)));
      }),
    },
    "/api/books/:id/apply-metadata": {
      POST: handle(async (req: Bun.BunRequest<"/api/books/:id/apply-metadata">) =>
        json(await lookups.apply(app, Number(req.params.id), await readJson<ApplyMetadataRequest>(req))),
      ),
    },
    "/api/review-queue": { GET: handle(() => json(lookups.reviewItems(app))) },
    "/api/review-queue/accept-fills": { POST: handle(async () => json(await lookups.acceptAllFills(app))) },
    "/api/review-queue/:id": {
      DELETE: handle((req: Bun.BunRequest<"/api/review-queue/:id">) => {
        lookups.dismiss(app, Number(req.params.id));
        return json(app.lookup.status());
      }),
    },
    "/api/*": notFound,
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
  const { abs, file } = books.fileOf(app, Number(req.params.id), req.params.hash);
  const download = new URL(req.url).searchParams.has("download");
  return serveFile(req, abs, {
    contentType: CONTENT_TYPES[file.format],
    etag: file.hash,
    disposition: contentDisposition(download ? "attachment" : "inline", file.filename),
  });
}
