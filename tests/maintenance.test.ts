import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import type { AppContext } from "../src/server/app.ts";
import { closeTestApp, makeJpeg, scratchDir, SLOW_RETENTION, testApp } from "./fixtures.ts";
import * as bookRepo from "../src/server/db/repo/books.ts";
import * as coverStore from "../src/server/covers/store.ts";
import * as books from "../src/server/services/books.ts";
import * as maintenance from "../src/server/services/maintenance.ts";

let tmp: string;
let root: string;
let app: AppContext;

beforeEach(() => {
  ({ tmp, root } = scratchDir("maint", ["A", "B"]));
  app = testApp(tmp, {}, { library: SLOW_RETENTION });
});

afterEach(() => closeTestApp(app, tmp));

const put = (rel: string, content = rel) => writeFileSync(join(root, rel), content);
const idOf = (rel: string) => app.library.index.get(rel)!.bookId;

/** Simulate files that vanished while the server was down (so the startup guard/grace don't apply). */
async function restartWithout(...rels: string[]) {
  await app.library.close();
  for (const r of rels) rmSync(join(root, r));
  await app.library.open(root);
}

describe("maintenance", () => {
  test("missing list, forget, and cleanup of unconfirmed rows + orphan covers", async () => {
    put("A/Kept -- Author.epub");
    put("A/Plain -- Author.epub");
    put("B/Stays -- Author.epub");
    await app.library.open(root);
    const kept = idOf("A/Kept -- Author.epub");
    const plain = idOf("A/Plain -- Author.epub");
    const stays = idOf("B/Stays -- Author.epub");
    await books.update(app, kept, { rating: 5 });
    await books.setCover(app, kept, await makeJpeg(200, 300));

    // Both files vanish while the server is down; the library is not empty, so the startup
    // cleanup drops the unconfirmed row and keeps the confirmed one.
    await restartWithout("A/Kept -- Author.epub", "A/Plain -- Author.epub");
    expect(bookRepo.exists(app.db, plain)).toBe(false); // startup cleanup (unconfirmed)
    expect(bookRepo.exists(app.db, kept)).toBe(true);

    const missing = await maintenance.missing(app);
    expect(missing).toEqual([
      expect.objectContaining({ id: kept, title: "Kept", confirmedSource: "manual", hasCover: true, formats: ["epub"] }),
    ]);
    const stats = maintenance.stats(app);
    expect(stats).toMatchObject({ booksOnDisk: 1, filesOnDisk: 1, metadataRows: 2, confirmed: 1, missing: 1, missingUnconfirmed: 0, coverFiles: 2, orphanCoverFiles: 0 });

    // Books on disk are never forgotten.
    expect(await maintenance.forget(app, [stays])).toEqual({ removedBooks: 0, removedCoverFiles: 0 });
    expect(bookRepo.exists(app.db, stays)).toBe(true);
    expect((await maintenance.forget(app, [stays + 1000])).removedBooks).toBe(0);

    expect((await maintenance.forget(app, [kept])).removedBooks).toBe(1);
    expect(bookRepo.exists(app.db, kept)).toBe(false);
    expect(existsSync(coverStore.path(app.config.coversDir, kept, "full"))).toBe(false);

    // Orphan cover files (e.g. left by a crash) are cleaned up.
    writeFileSync(join(app.config.coversDir, "999.jpg"), "x");
    writeFileSync(join(app.config.coversDir, "999.jpg.123.tmp"), "x");
    expect(maintenance.stats(app).orphanCoverFiles).toBe(2);
    expect(await maintenance.cleanup(app)).toEqual({ removedBooks: 0, removedCoverFiles: 2 });
    expect(readdirSync(app.config.coversDir)).toEqual([]);
  });

  test("manual cleanup removes unconfirmed rows the startup guard kept", async () => {
    put("A/One -- Author.epub");
    await app.library.open(root);
    const one = idOf("A/One -- Author.epub");
    await restartWithout("A/One -- Author.epub"); // library now empty → guard keeps metadata
    expect(bookRepo.exists(app.db, one)).toBe(true);
    expect(maintenance.stats(app)).toMatchObject({ missing: 1, missingUnconfirmed: 1 });
    expect((await maintenance.cleanup(app)).removedBooks).toBe(1);
    expect(bookRepo.exists(app.db, one)).toBe(false);
  });

  test("normalize a shelf, Unshelved, or everything", async () => {
    put("A/x -- Ann.epub");
    put("B/y -- Bob.epub");
    put("z -- Zed.epub");
    await app.library.open(root);
    expect((await maintenance.normalize(app, "A")).renamed).toEqual([{ from: "A/x -- Ann.epub", to: "A/Ann - x.epub" }]);
    expect((await maintenance.normalize(app, "")).renamed).toEqual([{ from: "z -- Zed.epub", to: "Zed - z.epub" }]);
    expect((await maintenance.normalize(app, undefined)).renamed).toEqual([{ from: "B/y -- Bob.epub", to: "B/Bob - y.epub" }]);
    await expect(maintenance.normalize(app, "../x")).rejects.toThrow();
  });

  test("HTTP: stats, missing, cleanup, cache, unavailable library", async () => {
    put("A/One -- Author.epub");
    await app.library.open(root);
    app.db.query("INSERT INTO http_cache (url, status, body, fetched_at) VALUES ('x', 200, '{}', '2026-01-01')").run();
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const call = (path: string, method = "GET", body?: unknown) =>
        fetch(`${server.url}${path.slice(1)}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      expect((await (await call("/api/maintenance/stats")).json()).httpCacheEntries).toBe(1);
      expect(await (await call("/api/maintenance/http-cache", "DELETE")).json()).toEqual({ removed: 1 });
      expect(await (await call("/api/maintenance/missing")).json()).toEqual([]);
      expect((await call("/api/maintenance/missing", "POST", { ids: "all" })).status).toBe(400);
      expect((await call("/api/maintenance/normalize", "POST", { shelf: 3 })).status).toBe(400);
      expect((await call("/api/maintenance/normalize", "POST", {})).status).toBe(200);
      expect((await call("/api/maintenance/cleanup", "POST")).status).toBe(200);

      await app.library.close();
      rmSync(root, { recursive: true });
      await app.library.open(root);
      expect((await call("/api/maintenance/missing")).status).toBe(503);
    } finally {
      server.stop(true);
    }
  });
});
