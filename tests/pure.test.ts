/** The pure rules behind the stateful parts (HTTP pacing, the library watcher, lookups, imports). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db/index.ts";
import type { IndexedFile } from "../src/server/library/libraryIndex.ts";
import { isUnchanged, scanOrder, shouldEmitStatus } from "../src/server/library/library.ts";
import { isPreferredFormat } from "../src/server/library/linker.ts";
import { looksUnavailable } from "../src/server/library/retention.ts";
import { coverUrls } from "../src/server/services/isbndbCovers.ts";
import { importResult, placedStatus, targetDir } from "../src/server/services/importService.ts";
import { parseRange } from "../src/server/api/files.ts";
import { namesChange } from "../src/server/services/books.ts";
import { missingBooks } from "../src/server/services/maintenance.ts";
import { classifyEntry } from "../src/server/services/shelves.ts";
import type { BookRecord } from "../src/server/db/repo/books.ts";
import { buildPatch, coverOptions, fillRequest, lookupIds, worksToExpand } from "../src/server/services/lookup/lookup.ts";
import { etaSeconds } from "../src/server/services/lookup/worker.ts";
import {
  cooldownMs,
  createHttpClient,
  isFresh,
  paceInterval,
  queuePosition,
  quotaBlockedUntil,
  quotaRemaining,
  readRateHeaders,
} from "../src/server/sources/http.ts";
import type { CoverOption, MetadataCandidate, ReviewItemDto } from "../src/shared/types.ts";

describe("HTTP pacing and quotas", () => {
  const ol = { intervalMs: 1100, identifiedIntervalMs: 500 };

  test("pace: the host's interval, faster once identified, never faster than advertised", () => {
    expect(paceInterval(ol, 1000, false, 0)).toBe(1100);
    expect(paceInterval(ol, 1000, true, 0)).toBe(500);
    expect(paceInterval(ol, 1000, true, 800)).toBe(800);
    expect(paceInterval(undefined, 1000, true, 0)).toBe(1000);
  });

  test("cooldown: Retry-After capped at an hour, else one minute doubling up to 30", () => {
    expect(cooldownMs(5000, 1)).toBe(5000);
    expect(cooldownMs(5 * 3600_000, 1)).toBe(3600_000);
    expect([1, 2, 3, 6, 9].map((n) => cooldownMs(null, n) / 60_000)).toEqual([1, 2, 4, 30, 30]);
  });

  test("quota: the lower of our count and the service's report", () => {
    expect(quotaRemaining(10, 4, null)).toBe(6);
    expect(quotaRemaining(10, 4, { left: 2, resetAt: 0 })).toBe(2);
    expect(quotaRemaining(undefined, 4, { left: 2, resetAt: 0 })).toBe(2);
    expect(quotaRemaining(undefined, 4, null)).toBeNull();
    const now = Date.UTC(2026, 10, 20, 15);
    expect(quotaBlockedUntil(1, 10, 10, null, now)).toBe(Date.UTC(2026, 10, 21));
    expect(quotaBlockedUntil(1, 10, 9, { left: 0, resetAt: 42 }, now)).toBe(42);
    expect(quotaBlockedUntil(0, 10, 10, null, now)).toBeNull(); // free requests always go
    expect(quotaBlockedUntil(1, 10, 9, null, now)).toBeNull();
  });

  test("queue: interactive requests go before queued background ones, in order", () => {
    const q = [{ priority: "interactive" as const }, { priority: "background" as const }, { priority: "background" as const }];
    expect(queuePosition(q, "interactive")).toBe(1);
    expect(queuePosition(q, "background")).toBe(3);
    expect(queuePosition([], "interactive")).toBe(0);
  });

  test("rate headers: advertised pace, daily report, spent window", () => {
    const h = new Headers({
      "x-rate-limit-limit": "5",
      "x-rate-limit-interval": "1s",
      ratelimit: '"rate";r=0;t=7, "daily";r=48;t=100',
    });
    expect(readRateHeaders(h, 1000)).toEqual({ advertisedMs: 221, daily: { left: 48, resetAt: 101_000 }, rateResetAt: 8000, retryAfterMs: 7000 });
    expect(readRateHeaders(new Headers({ "retry-after": "3" }), 0)).toEqual({ advertisedMs: null, daily: null, rateResetAt: null, retryAfterMs: 3000 });
  });

  test("cache freshness: 404s expire sooner", () => {
    const ttl = { okTtlMs: 1000, notFoundTtlMs: 100 };
    const at = new Date(0).toISOString();
    expect(isFresh(200, at, 1000, ttl)).toBe(true);
    expect(isFresh(200, at, 1001, ttl)).toBe(false);
    expect(isFresh(404, at, 101, ttl)).toBe(false);
  });

  describe("cache with a fake clock", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("entries are dated and expire by the client's own clock", async () => {
      dir = mkdtempSync(join(tmpdir(), "bookshelf-httpcache-"));
      const db = openDatabase(join(dir, "db.sqlite"));
      let t = Date.UTC(2020, 0, 1); // far from the real time
      let calls = 0;
      const fetchImpl = (async () => (calls++, new Response('{"n":1}'))) as unknown as typeof fetch;
      const http = createHttpClient(db, () => null, { fetchImpl, now: () => t, sleep: async () => {}, okTtlMs: 1000 });
      await http.getJson("https://example.org/a");
      expect(http.isCached("https://example.org/a")).toBe(true);
      t += 1001;
      expect(http.isCached("https://example.org/a")).toBe(false);
      await http.getJson("https://example.org/a");
      expect(calls).toBe(2);
      db.close();
    });
  });
});

describe("library and linking rules", () => {
  const file = (over: Partial<IndexedFile>) => ({ size: 10, mtimeMs: 1000, ...over }) as IndexedFile;

  test("a file is unchanged only with the same size and (truncated) mtime", () => {
    expect(isUnchanged(file({}), { size: 10, mtimeMs: 1000.7 })).toBe(true);
    expect(isUnchanged(file({}), { size: 11, mtimeMs: 1000 })).toBe(false);
    expect(isUnchanged(undefined, { size: 10, mtimeMs: 1000 })).toBe(false);
  });

  test("scans start with the best metadata sources", () => {
    const f = (format: string) => ({ detected: { format } }) as { detected: { format: "pdf" | "epub" | "djvu" } };
    expect(scanOrder([f("pdf"), f("djvu"), f("epub")]).map((x) => x.detected.format)).toEqual(["epub", "djvu", "pdf"]);
  });

  test("status events are throttled unless forced", () => {
    expect(shouldEmitStatus(false, 1000, 900)).toBe(false);
    expect(shouldEmitStatus(false, 1250, 1000)).toBe(true);
    expect(shouldEmitStatus(true, 1000, 999)).toBe(true);
  });

  test("a format is preferred only when it beats every other one on disk", () => {
    expect(isPreferredFormat("epub", ["pdf"])).toBe(true);
    expect(isPreferredFormat("pdf", ["epub"])).toBe(false);
    expect(isPreferredFormat("pdf", [])).toBe(true);
  });

  test("an empty scan with metadata present looks like a missing drive", () => {
    expect(looksUnavailable(0, 3)).toBe(true);
    expect(looksUnavailable(0, 0)).toBe(false);
    expect(looksUnavailable(2, 3)).toBe(false);
  });
});

describe("ISBNdb covers", () => {
  test("the original link only while fresh, then the 450 px image", () => {
    const record = { image_original: "https://images.isbndb.com/o.jpg", image: "https://images.isbndb.com/i.jpg" };
    const sent = Date.UTC(2026, 0, 1);
    expect(coverUrls(record, new Date(sent).toISOString(), sent + 60_000)).toEqual([record.image_original, record.image]);
    expect(coverUrls(record, new Date(sent).toISOString(), sent + 3 * 3600_000)).toEqual([record.image]);
    expect(coverUrls({ image: "http://insecure/x.jpg" }, new Date(sent).toISOString(), sent)).toEqual([]);
  });
});

describe("lookup rules", () => {
  const candidate = (over: Partial<MetadataCandidate> & { title?: string }): MetadataCandidate => ({
    source: "openlibrary",
    match: "isbn",
    id: "x",
    url: "https://openlibrary.org/x",
    label: "Open Library",
    metadata: { title: over.title ?? "Dune", subtitle: null, authors: ["Frank Herbert"], isbn13: null, doi: null, publisher: null, edition: null, publishedDate: null, language: null, pages: null, description: null, series: "Dune", seriesIndex: 1, tags: [] },
    coverUrl: null,
    olEditionKey: null,
    olWorkKey: null,
    ...over,
  });

  test("identifiers: typed text wins and is exact", () => {
    expect(lookupIds({ isbn13: "9780441172719", doi: null }, undefined)).toEqual({ isbn: "9780441172719", doi: null, typedId: false });
    expect(lookupIds({ isbn13: "9780441172719", doi: null }, "10.1000/x")).toEqual({ isbn: null, doi: "10.1000/x", typedId: true });
    expect(lookupIds({ isbn13: "9780441172719", doi: null }, "dune")).toEqual({ isbn: null, doi: null, typedId: false });
  });

  test("patch: candidate fields win over edits, never clear, and a series number needs a series", () => {
    const c = candidate({});
    expect(buildPatch({ candidate: c, fields: ["title", "subtitle"], edits: { title: "Mine", notes: "n" }, cover: false }, c, false)).toEqual({ title: "Dune", notes: "n" });
    expect(buildPatch({ candidate: c, fields: ["seriesIndex"], cover: false }, c, false)).toEqual({});
    expect(buildPatch({ candidate: c, fields: ["seriesIndex"], cover: false }, c, true)).toEqual({ seriesIndex: 1 });
    expect(buildPatch({ candidate: c, fields: ["series", "seriesIndex"], cover: false }, c, false)).toEqual({ series: "Dune", seriesIndex: 1 });
  });

  test("covers: own work, same-title works once each; editions in the book's language first, own edition on top", () => {
    const own = candidate({ olWorkKey: "W1", coverUrl: "https://c/own" });
    const works = [candidate({ olWorkKey: "W1" }), candidate({ olWorkKey: "W2", title: "Dune: Deluxe" }), candidate({ olWorkKey: "W3", title: "Dune Messiah", coverUrl: "https://c/m" })];
    expect(worksToExpand(own, works, "Dune").map(([k]) => k)).toEqual(["W1", "W2"]);
    expect(worksToExpand(null, [works[2]!], "Dune").map(([k]) => k)).toEqual(["W3"]);

    const edition = (coverUrl: string, language: string | null, isbn13: string | null = null): CoverOption => ({
      coverUrl, url: "", title: "Dune", subtitle: null, authors: [], details: "", language, isbn13, thisEdition: false,
    });
    const options = coverOptions(
      { isbn13: "9780441172719", language: "de" },
      own,
      works,
      [edition("https://c/en", "en"), edition("https://c/de", "de"), edition("https://c/own", null), edition("https://c/mine", "en", "9780441172719")],
      new Set(["W1", "W2"]),
    );
    expect(options.map((o) => o.coverUrl)).toEqual(["https://c/mine", "https://c/own", "https://c/de", "https://c/en", "https://c/m"]);
    expect(options[0]!.thisEdition).toBe(true);
  });

  test("accept all fills: only identifier matches, only missing fields, the cover only when missing", () => {
    const best = { ...candidate({ coverUrl: "https://c/x" }), diff: [{ field: "title" as const, current: "Dune", candidate: "Dune", status: "same" as const }, { field: "publisher" as const, current: null, candidate: "Ace", status: "fill" as const }] };
    const item = (over: object, hasCover = false) => ({ book: { id: 1, hasCover }, result: { candidates: [{ ...best, ...over }] } }) as unknown as ReviewItemDto;
    expect(fillRequest(item({}))).toMatchObject({ fields: ["publisher"], cover: true });
    expect(fillRequest(item({}, true))).toMatchObject({ cover: false });
    expect(fillRequest(item({ match: "search" }))).toBeNull();
  });

  test("time left: average per book plus what is left of a pause", () => {
    expect(etaSeconds([1000, 3000], 5, 0)).toBe(10);
    expect(etaSeconds([1000], 2, 4000)).toBe(6);
    expect(etaSeconds([], 5, 0)).toBeNull();
    expect(etaSeconds([1000], 0, 0)).toBeNull();
  });
});

describe("import rules", () => {
  test("status and target directory", () => {
    expect(placedStatus("created", false)).toBe("imported");
    expect(placedStatus("identifier", true)).toBe("attached");
    expect(placedStatus("identifier", false)).toBe("reconnected");
    const existing = [{ relPath: "SF/Dune.epub" }, { relPath: "Other/Dune.pdf" }] as IndexedFile[];
    expect(targetDir("attached", existing, "Chosen")).toBe("SF");
    expect(targetDir("attached", [{ relPath: "Dune.epub" }] as IndexedFile[], "Chosen")).toBe("");
    expect(targetDir("imported", existing, "Chosen")).toBe("Chosen");
    expect(targetDir("reconnected", existing, null)).toBe("");
  });

  test("result: shelf from the path, default messages", () => {
    const detected = { format: "pdf" as const, ext: ".pdf", stem: "x" };
    expect(importResult("attached", 7, { title: "T", authors: ["A"] }, "SF/T.pdf", detected)).toMatchObject({
      shelf: "SF",
      message: "Added PDF to an existing book",
      lookupQueued: false,
    });
    expect(importResult("duplicate", 7, null, "T.pdf", detected, "Already there")).toMatchObject({ shelf: null, title: "", message: "Already there" });
  });
});

describe("service rules", () => {
  test("byte ranges: explicit, open-ended, suffix; unsatisfiable ones are null", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(["bytes=-", "bytes=9-3", "bytes=100-", "bytes=1-2,4-5", "items=0-1"].map((h) => parseRange(h, 100))).toEqual([null, null, null, null, null]);
  });

  test("shelf entries: books, OS junk, everything else", () => {
    expect(classifyEntry("Dune.epub", "SF/Dune.epub", true)).toBe("book");
    expect(classifyEntry(".DS_Store", "SF/.DS_Store", true)).toBe("junk");
    expect(classifyEntry("Dune.epub.part", "SF/Dune.epub.part", true)).toBe("other");
    expect(classifyEntry("Dune.epub", "SF/.hidden/Dune.epub", true)).toBe("other");
    expect(classifyEntry("notes.txt", "SF/notes.txt", true)).toBe("other");
  });

  test("filenames change with title, authors or identifiers only", () => {
    const m = { title: "Dune", authors: ["Frank Herbert"], isbn13: null, doi: null, publisher: "Ace" } as unknown as BookRecord;
    expect(namesChange(m, { ...m, publisher: "Chilton" })).toBe(false);
    expect(namesChange(m, { ...m, authors: ["Frank Herbert", "Brian Herbert"] })).toBe(true);
    expect(namesChange(m, { ...m, isbn13: "9780441172719" })).toBe(true);
  });

  test("books without files: formats as stored, sorted by title (numbers in order)", () => {
    const b = (id: number, title: string) => ({ id, title, authors: [], isbn13: null, doi: null, confirmedSource: null, hasCover: false, updatedAt: "" }) as unknown as BookRecord;
    const list = missingBooks([b(1, "Vol 10"), b(2, "vol 9"), b(3, "Alpha")], new Map([[1, ["epub", "pdf"] as const]]));
    expect(list.map((x) => x.title)).toEqual(["Alpha", "vol 9", "Vol 10"]);
    expect(list.find((x) => x.id === 1)!.formats).toEqual(["epub", "pdf"]);
  });
});
