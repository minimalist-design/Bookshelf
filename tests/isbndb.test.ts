import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { createHttpClient, ISBNDB_HOST, ISBNDB_IMAGES_HOST, isbndbLimit, parseRateLimit, QuotaExceededError } from "../src/server/sources/http.ts";
import { isbndbCandidate, isbndbKeptSearch } from "../src/server/sources/isbndb.ts";
import type { IsbndbRecord } from "../src/server/db/repo/isbndbRecords.ts";
import { closeTestApp, makeJpeg, scratchDir, testApp } from "./fixtures.ts";
import * as bookRepo from "../src/server/db/repo/books.ts";
import * as isbndbRecords from "../src/server/db/repo/isbndbRecords.ts";
import * as lookups from "../src/server/services/lookup/lookup.ts";

const KEY = "test-isbndb-key";

/** ISBNdb's record for Dune, shaped as in docs/isbndb-openapi.json (fields with no value left out). */
const DUNE = {
  title: "Dune",
  title_long: "Dune",
  isbn: "9780441172719",
  isbn13: "9780441172719",
  isbn10: "0441172717",
  binding: "Paperback",
  publisher: "Ace",
  language: "eng",
  date_published: "1990-09-01",
  edition_number: 1,
  pages: 535,
  synopsis: "<p>Set on the desert planet <b>Arrakis</b>.</p>",
  image: "https://images.isbndb.com/covers/9780441172719.jpg",
  image_original: "https://images.isbndb.com/covers/original/9780441172719.jpg?expires=soon",
  authors: ["Herbert, Frank"],
  genres: ["Science fiction", "Fiction"],
  other_isbns: [{ isbn: "9780593099322", binding: "Hardcover" }],
  thema: [{ code: "FLC", name: "Science fiction: space opera", type: "subject", main: true }],
};
/** Another book the title search for Dune finds: not the one wanted, kept all the same. */
const DUNE_MESSIAH = { ...DUNE, title: "Dune Messiah", isbn: "9780593098233", isbn13: "9780593098233", image: undefined, image_original: undefined };
const HOBBIT = {
  ...DUNE,
  title: "The Hobbit",
  isbn: "9780547928227",
  isbn13: "9780547928227",
  authors: ["J. R. R. Tolkien"],
  genres: ["Fantasy"],
  image: "https://images.isbndb.com/covers/9780547928227.jpg",
  image_original: undefined, // the 450 px image only
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake ISBNdb (plus an empty Open Library); `daily` is what its RateLimit header reports as left. */
const JPEG = await makeJpeg(30, 45);

function fakeIsbndb(opts: { daily?: () => number } = {}) {
  const calls: Call[] = [];
  const books = new Map([DUNE, HOBBIT, DUNE_MESSIAH].map((b) => [b.isbn13, b]));
  const headers = () => ({ ratelimit: `"rate";r=59;t=0, "daily";r=${opts.daily?.() ?? 4000};t=3600` });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: url.toString(), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    if (url.host === ISBNDB_HOST) {
      if (url.pathname.startsWith("/book/")) {
        const b = books.get(url.pathname.slice(6));
        return b ? Response.json({ book: b }, { headers: headers() }) : Response.json({ message: "Book not found", errorMessage: "Book not found" }, { status: 404, headers: headers() });
      }
      if (url.pathname === "/books" && init?.method === "POST") {
        const isbns = (body as { isbns: string[] }).isbns;
        const data = isbns.map((i) => books.get(i)).filter(Boolean);
        return Response.json({ total: data.length, requested: isbns.length, data }, { headers: headers() });
      }
      if (url.pathname.startsWith("/books/")) {
        const q = decodeURIComponent(url.pathname.slice(7)).toLowerCase();
        const found = [...books.values()].filter((b) => b.title.toLowerCase().includes(q));
        return Response.json({ total: found.length, page: 1, page_size: 8, books: found }, { headers: headers() });
      }
      if (url.pathname === "/key") {
        return Response.json({ api_host: ISBNDB_HOST, plan_name: "Basic", bulk_limit: 100, plan_limit: { total: 5000, spent: 1000, left: 4000 } });
      }
    }
    if (url.host === ISBNDB_IMAGES_HOST && url.search.includes("expired")) return new Response("Forbidden", { status: 403 });
    if (url.host === ISBNDB_IMAGES_HOST) return new Response(new Blob([JPEG as BlobPart]), { headers: { "content-type": "image/jpeg" } });
    if (url.host === "openlibrary.org") return Response.json(url.pathname === "/search.json" ? { docs: [] } : {});
    if (url.host === "api.crossref.org") return Response.json({ message: { items: [] } });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls, isbndbCalls: () => calls.filter((c) => c.url.includes(ISBNDB_HOST)) };
}

describe("ISBNdb records", () => {
  test("map onto the book's fields: names, language, date, edition, synopsis without markup, genres as tags", () => {
    const c = isbndbCandidate(DUNE, "isbn")!;
    expect(c).toMatchObject({
      source: "isbndb",
      match: "isbn",
      id: "9780441172719",
      url: "https://isbndb.com/book/9780441172719",
      coverUrl: "https://images.isbndb.com/covers/9780441172719.jpg",
      label: "ISBNdb · Ace · Paperback · 1990 · 535 pages",
    });
    expect(c.metadata).toMatchObject({
      title: "Dune",
      authors: ["Frank Herbert"],
      isbn13: "9780441172719",
      language: "en",
      publishedDate: "1990-09-01",
      edition: null, // a first edition says nothing
      description: "Set on the desert planet Arrakis.",
      tags: ["Science fiction", "Fiction"],
    });
    expect(isbndbCandidate({ ...DUNE, edition_number: 3 }, "isbn")!.metadata.edition).toBe("3");
    expect(isbndbCandidate({ title: "No ISBN" }, "search")).toBeNull();
  });

  test("RateLimit headers: requests left and seconds to reset, per policy", () => {
    expect(parseRateLimit('"rate";r=297;t=0, "daily";r=48999;t=56312')).toEqual(
      new Map([
        ["rate", { left: 297, resetSeconds: 0 }],
        ["daily", { left: 48999, resetSeconds: 56312 }],
      ]),
    );
    expect(parseRateLimit(null).size).toBe(0);
  });
});

describe("searching the kept records", () => {
  const store = (...records: IsbndbRecord[]) => ({ containing: () => records });

  test("a book's own title and author: sure only with exactly that title by that author", () => {
    const both = isbndbKeptSearch(store(DUNE_MESSIAH, DUNE), { title: "Dune", author: "Frank Herbert" });
    expect(both.sure).toBe(true);
    expect(both.candidates.map((c) => c.metadata.title)).toEqual(["Dune", "Dune Messiah"]); // the sure one first
    expect(both.candidates.every((c) => c.kept && c.match === "search")).toBe(true);
    expect(isbndbKeptSearch(store(DUNE_MESSIAH), { title: "Dune", author: "Frank Herbert" }).sure).toBe(false);
    expect(isbndbKeptSearch(store(DUNE), { title: "Dune", author: "Kevin J. Anderson" }).candidates).toEqual([]);
    expect(isbndbKeptSearch(store(DUNE), { title: "Dune: Deluxe Edition", author: null }).sure).toBe(true); // subtitle aside
  });

  test("typed text: sure when the text, without the record's author names, is its title", () => {
    expect(isbndbKeptSearch(store(DUNE), { q: "Dune Frank Herbert" }).sure).toBe(true);
    expect(isbndbKeptSearch(store(DUNE), { q: "herbert dune" }).sure).toBe(true);
    expect(isbndbKeptSearch(store(DUNE_MESSIAH), { q: "dune" })).toMatchObject({ sure: false, candidates: [{ metadata: { title: "Dune Messiah" } }] });
  });
});

describe("ISBNdb quota in the HTTP client", () => {
  const limits = isbndbLimit({ perSecond: 1, dailyLimit: 5 });
  const url = (isbn: string) => `https://${ISBNDB_HOST}/book/${isbn}`;

  test("bulk calls cost one per ISBN; past the daily limit nothing is sent", async () => {
    const net = fakeIsbndb();
    const http = createHttpClient(null, () => null, { fetchImpl: net.fetchImpl, sleep: async () => {}, hostLimits: limits });
    await http.post(`https://${ISBNDB_HOST}/books`, { isbns: ["a", "b", "c", "d"] }, { cost: 4 });
    expect(http.spentToday(ISBNDB_HOST)).toBe(4);
    expect(http.quotaLeft(ISBNDB_HOST)).toBe(1);
    await http.getJson(url("9780441172719"));
    await expect(http.getJson(url("9780547928227"))).rejects.toBeInstanceOf(QuotaExceededError);
    expect(net.isbndbCalls()).toHaveLength(2); // the refused request was never sent
    // Usage shows the day's calls against the limit, with the reset at the next 00:00 UTC.
    const u = http.usage(0).services.find((s) => s.host === ISBNDB_HOST)!;
    expect(u).toMatchObject({ name: "ISBNdb", dailyLimit: 5, today: 5, reportedLeft: 4000 });
    expect(u.quotaResetsAt!.endsWith("T00:00:00.000Z")).toBe(true);
  });

  test("what ISBNdb reports as left counts too (calls made elsewhere with the key)", async () => {
    let left = 1;
    const net = fakeIsbndb({ daily: () => left });
    const http = createHttpClient(null, () => null, { fetchImpl: net.fetchImpl, sleep: async () => {}, hostLimits: isbndbLimit({ perSecond: 1, dailyLimit: 5000 }) });
    await http.getJson(url("9780441172719"));
    expect(http.quotaLeft(ISBNDB_HOST)).toBe(1);
    left = 0;
    await http.getJson(url("9780547928227"));
    await expect(http.getJson(url("9780000000002"))).rejects.toBeInstanceOf(QuotaExceededError);
    expect(net.isbndbCalls()).toHaveLength(2);
  });

  test("a 429 for the daily quota fails at once, without a cooldown; a spent rate window is waited out", async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () =>
      ++n === 1
        ? new Response("{}", { headers: { ratelimit: '"rate";r=0;t=7, "daily";r=10;t=100' } })
        : new Response('{"message":"Daily quota exceeded, please try again later"}', { status: 429, headers: { ratelimit: '"rate";r=50;t=0, "daily";r=0;t=100' } })) as unknown as typeof fetch;
    // A fixed clock: with the real one a millisecond may pass between the answer and the next wait.
    const at = Date.UTC(2026, 10, 20, 12);
    const http = createHttpClient(null, () => null, {
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      now: () => at,
      hostLimits: isbndbLimit({ perSecond: 1, dailyLimit: 5000 }),
    });
    await http.get(url("1"));
    await expect(http.get(url("2"))).rejects.toBeInstanceOf(QuotaExceededError);
    expect(n).toBe(2); // not retried
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(7000); // waited for the rate window
    expect(http.cooldowns()).toEqual([]);
  });
});

describe("lookups with ISBNdb", () => {
  let tmp: string;
  let root: string;
  let app: AppContext;
  let net: ReturnType<typeof fakeIsbndb>;

  const start = (dailyLimit = 5000) => {
    net = fakeIsbndb();
    app = testApp(tmp, { isbndb_daily_limit: dailyLimit }, { http: { fetchImpl: net.fetchImpl, sleep: async () => {} } }, { ISBNDB_API_KEY: KEY });
  };
  beforeEach(() => {
    ({ tmp, root } = scratchDir("isbndb", ["S"]));
  });
  afterEach(() => closeTestApp(app, tmp));

  const put = (rel: string) => writeFileSync(join(root, rel), rel);
  const idOf = (rel: string) => app.library.index.get(rel)!.bookId;

  const ISBNDB = { source: "isbndb" } as const;

  test("automatic lookups never call ISBNdb, even with a key: Open Library and the DOI registries are asked", async () => {
    start();
    put("S/Frank Herbert - Dune [9780441172719].epub");
    put("S/Frank Herbert - Dune Messiah.epub");
    await app.library.open(root);
    const byIsbn = await lookups.find(app, idOf("S/Frank Herbert - Dune [9780441172719].epub"));
    const byTitle = await lookups.find(app, idOf("S/Frank Herbert - Dune Messiah.epub"), { q: "Dune Messiah" });
    expect([...byIsbn.errors, ...byTitle.errors]).toEqual([]);
    expect(net.isbndbCalls()).toEqual([]);
    expect(net.calls.some((c) => c.url.includes("openlibrary.org/api/books"))).toBe(true);
    expect(net.calls.some((c) => c.url.includes("openlibrary.org/search.json"))).toBe(true);
    expect(app.http.spentToday(ISBNDB_HOST)).toBe(0);
  });

  test("ISBNdb picked by name is asked, with the key in the Authorization header; applying confirms from ISBNdb", async () => {
    start();
    put("S/Frank Herbert - Dune [9780441172719].epub");
    await app.library.open(root);
    const id = idOf("S/Frank Herbert - Dune [9780441172719].epub");
    const r = await lookups.find(app, id, ISBNDB);
    expect(r.errors).toEqual([]);
    expect(r.candidates.map((c) => c.source)).toEqual(["isbndb"]);
    expect(net.calls.some((c) => c.url.includes("openlibrary.org"))).toBe(false); // ISBNdb only
    expect(net.isbndbCalls()[0]!.headers.authorization).toBe(KEY);

    const applied = await lookups.apply(app, id, { candidate: r.candidates[0]!, fields: ["publisher", "pages"], cover: false });
    expect(applied.book).toMatchObject({ publisher: "Ace", pages: 535, confirmedSource: "isbndb" });

    // The search form picks it over HTTP the same way.
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const res = await fetch(`${server.url}api/lookup/${id}?source=isbndb`);
      expect(res.status).toBe(200);
      expect((await res.json()).candidates.map((c: { source: string }) => c.source)).toEqual(["isbndb"]);
      expect(net.isbndbCalls()).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("a used-up daily quota stops ISBNdb lookups, and the user is told why", async () => {
    start(2);
    put("S/Someone - Unknown Book [9780000000002].epub");
    put("S/Frank Herbert - Dune [9780441172719].epub");
    await app.library.open(root);
    const unknown = await lookups.find(app, idOf("S/Someone - Unknown Book [9780000000002].epub"), ISBNDB);
    expect(unknown.errors).toEqual([]);
    // Its ISBN and then its title were asked: the day's two calls are spent.
    expect(net.isbndbCalls()).toHaveLength(2);
    const dune = await lookups.find(app, idOf("S/Frank Herbert - Dune [9780441172719].epub"), ISBNDB);
    expect(dune.errors.join()).toContain("ISBNdb's daily limit is used up");
    expect(net.isbndbCalls()).toHaveLength(2);
  });

  test("books without an ISBN are searched in ISBNdb by title; every result is kept, the wrong books too", async () => {
    start();
    put("S/Frank Herbert - Dune.epub");
    put("S/Frank Herbert - Dune Messiah [9780593098233].epub");
    await app.library.open(root);
    const r = await lookups.find(app, idOf("S/Frank Herbert - Dune.epub"), ISBNDB);
    expect(r.candidates[0]).toMatchObject({ source: "isbndb", match: "search" });
    const search = net.isbndbCalls().find((c) => c.url.includes("/books/"))!;
    expect(search.url).toContain("/books/Dune?");
    expect(search.url).toContain("column=title");
    expect(search.url).toContain("pageSize=100"); // a search costs one call however many it returns

    // Both results are kept as ISBNdb sent them, every field included.
    expect(isbndbRecords.count(app.db)).toBe(2);
    expect(isbndbRecords.get(app.db, "9780441172719")).toEqual(DUNE);
    // Dune Messiah came with that search: an automatic lookup finds it in the kept records.
    const before = net.isbndbCalls().length;
    const messiah = await lookups.find(app, idOf("S/Frank Herbert - Dune Messiah [9780593098233].epub"));
    expect(messiah.candidates[0]).toMatchObject({ source: "isbndb", match: "isbn", id: "9780593098233", kept: true });
    expect(net.isbndbCalls()).toHaveLength(before);
  });

  test("kept records answer later lookups without a call", async () => {
    start();
    put("S/Frank Herbert - Dune [9780441172719].epub");
    await app.library.open(root);
    const id = idOf("S/Frank Herbert - Dune [9780441172719].epub");
    await lookups.find(app, id, ISBNDB);
    expect(net.isbndbCalls()).toHaveLength(1);
    expect(isbndbRecords.count(app.db)).toBe(1);
    const again = await lookups.find(app, id);
    expect(again.candidates[0]).toMatchObject({ source: "isbndb", kept: true });
    expect(net.isbndbCalls()).toHaveLength(1);
  });

  test("bulk lookups never call ISBNdb; kept records answer, Open Library the rest", async () => {
    start();
    app.isbndbStore.putMany([DUNE], "book", () => DUNE.isbn13);
    put("S/Frank Herbert - Dune [9780441172719].epub");
    put("S/J. R. R. Tolkien - The Hobbit [9780547928227].epub");
    put("S/Someone - Unknown Book [9780000000002].epub");
    await app.library.open(root);
    app.lookup.enqueue(app.library.index.bookIds());
    await app.lookup.idle();

    expect(net.isbndbCalls()).toEqual([]);
    expect(app.http.spentToday(ISBNDB_HOST)).toBe(0);
    expect(app.lookup.status()).toMatchObject({ done: 3, failed: 0 });
    expect(lookups.reviewItems(app).map((i) => i.result.candidates[0]).filter((c) => c?.source === "isbndb")).toMatchObject([{ id: DUNE.isbn13, kept: true }]);
    expect(net.calls.filter((c) => c.url.includes("openlibrary.org/api/books")).length).toBeGreaterThanOrEqual(2);
  });

  test("title searches read the kept records; only ISBNdb picked by name asks it", async () => {
    start();
    put("S/Frank Herbert - Dune Messiah.epub");
    put("S/Frank Herbert - Dune.epub");
    put("S/Frank Herbert - Children of Dune.epub");
    await app.library.open(root);
    const search = () => net.isbndbCalls().filter((c) => c.url.includes("/books/"));

    // Picked by name: ISBNdb is searched, and both Dune books come back and are kept.
    const dune = await lookups.find(app, idOf("S/Frank Herbert - Dune.epub"), ISBNDB);
    expect(dune.candidates.map((c) => c.metadata.title)).toEqual(["Dune", "Dune Messiah"]);
    expect(dune.candidates[0]!.kept).toBeUndefined();
    expect(search()).toHaveLength(1);

    // Dune Messiah came with that search: found in the kept records, no call.
    const messiah = await lookups.find(app, idOf("S/Frank Herbert - Dune Messiah.epub"));
    expect(messiah.candidates[0]).toMatchObject({ kept: true, metadata: { title: "Dune Messiah" } });
    expect(search()).toHaveLength(1);

    // Kept records mention Dune, but none is "Children of Dune": still no call unless asked for.
    await lookups.find(app, idOf("S/Frank Herbert - Children of Dune.epub"));
    expect(search()).toHaveLength(1);
    await lookups.find(app, idOf("S/Frank Herbert - Children of Dune.epub"), ISBNDB);
    expect(search()).toHaveLength(2);

    // Picking ISBNdb by name always asks it, even when a kept record is surely the book.
    await lookups.find(app, idOf("S/Frank Herbert - Dune.epub"), ISBNDB);
    expect(search()).toHaveLength(3);
  });

  test("every kept record's cover is downloaded: the full-size original first, else the 450 px image", async () => {
    start();
    put("S/Frank Herbert - Dune [9780441172719].epub");
    put("S/J. R. R. Tolkien - The Hobbit [9780547928227].epub");
    put("S/Frank Herbert - Dune Messiah [9780593098233].epub");
    await app.library.open(root);
    for (const id of app.library.index.bookIds()) await lookups.find(app, id, ISBNDB);
    await app.isbndbCovers.idle();

    const images = net.calls.filter((c) => c.url.includes(ISBNDB_IMAGES_HOST)).map((c) => c.url);
    expect(images.sort()).toEqual([DUNE.image_original, HOBBIT.image].sort());
    const dir = join(tmp, "data", "isbndb-covers");
    expect(readFileSync(join(dir, "9780441172719.jpg"))).toEqual(Buffer.from(JPEG));
    expect(existsSync(join(dir, "9780547928227.jpg"))).toBe(true);
    expect(isbndbRecords.coverStats(app.db)).toEqual({ files: 2, bytes: 2 * JPEG.byteLength, pending: 0 }); // Messiah has no image
    expect(isbndbRecords.count(app.db)).toBe(3);

    // Applying an ISBNdb cover takes the kept file: nothing is downloaded again.
    const id = idOf("S/Frank Herbert - Dune [9780441172719].epub");
    const r = await lookups.find(app, id);
    await lookups.apply(app, id, { candidate: r.candidates[0]!, fields: [], cover: true });
    expect(bookRepo.get(app.db, id)).toMatchObject({ hasCover: true, coverSource: "isbndb" });
    expect(net.calls.filter((c) => c.url.includes(ISBNDB_IMAGES_HOST))).toHaveLength(2);
  });

  test("an expired full-size link falls back to the 450 px image", async () => {
    start();
    app.isbndbStore.putMany([{ ...DUNE, image_original: "https://images.isbndb.com/covers/original/x.jpg?expired=1" }], "book", () => DUNE.isbn13);
    await app.isbndbCovers.idle();
    expect(net.calls.filter((c) => c.url.includes(ISBNDB_IMAGES_HOST)).map((c) => c.url)).toEqual([
      "https://images.isbndb.com/covers/original/x.jpg?expired=1",
      DUNE.image,
    ]);
    expect(isbndbRecords.coverFile(app.db, DUNE.isbn13)).toBe("9780441172719.jpg");
  });

  test("kept records answer even without a key", async () => {
    net = fakeIsbndb();
    app = createApp(loadConfig({ data_dir: join(tmp, "data") }, {}), { http: { fetchImpl: net.fetchImpl, sleep: async () => {} } });
    app.isbndbStore.putMany([DUNE], "search", () => DUNE.isbn13);
    put("S/Frank Herbert - Dune [9780441172719].epub");
    put("S/Frank Herbert - Dune.epub");
    await app.library.open(root);
    expect((await lookups.find(app, idOf("S/Frank Herbert - Dune [9780441172719].epub"))).candidates[0]).toMatchObject({ source: "isbndb", kept: true });
    expect((await lookups.find(app, idOf("S/Frank Herbert - Dune.epub"))).candidates[0]).toMatchObject({ source: "isbndb", kept: true });
    expect(net.isbndbCalls()).toEqual([]);
  });

  test("settings say whether ISBNdb is used; the key endpoint reports the plan and today's quota", async () => {
    start();
    await app.library.open(root);
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const settings = await (await fetch(`${server.url}api/settings`)).json();
      expect(settings.isbndb).toEqual({ configured: true, dailyLimit: 5000, perSecond: 1 });
      expect(await (await fetch(`${server.url}api/isbndb/key`)).json()).toEqual({ planName: "Basic", bulkLimit: 100, total: 5000, spent: 1000, left: 4000 });
      expect(app.http.spentToday(ISBNDB_HOST)).toBe(0); // checking the key is free
    } finally {
      server.stop(true);
    }
  });

  test("without a key, ISBNdb is neither used nor listed, and asking for it explains why", async () => {
    net = fakeIsbndb();
    app = createApp(loadConfig({ data_dir: join(tmp, "data") }, {}), { http: { fetchImpl: net.fetchImpl, sleep: async () => {} } });
    put("S/Frank Herbert - Dune [9780441172719].epub");
    await app.library.open(root);
    const id = idOf("S/Frank Herbert - Dune [9780441172719].epub");
    await lookups.find(app, id);
    expect(net.isbndbCalls()).toEqual([]);
    expect(app.http.usage(0).services.some((s) => s.host === ISBNDB_HOST)).toBe(false);
    await expect(lookups.find(app, id, { source: "isbndb" })).rejects.toThrow("ISBNDB_API_KEY");
    expect(await lookups.isbndbKey(app)).toBeNull();
  });
});
