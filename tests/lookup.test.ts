import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { ValidationError } from "../src/server/library/paths.ts";
import { lookupDoi } from "../src/server/sources/doi.ts";
import { HttpClient } from "../src/server/sources/http.ts";
import { cleanSubjects, normalizeLanguage, parseLooseDate, parseSeries } from "../src/server/sources/normalize.ts";
import { openLibraryByIsbn, openLibrarySearch } from "../src/server/sources/openlibrary.ts";
import type { MetadataCandidate } from "../src/shared/types.ts";
import { makeJpeg } from "./fixtures.ts";

const FIX = join(import.meta.dir, "fixtures/http");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Fake network serving recorded responses. */
async function fakeNetwork(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const jpeg = await makeJpeg(300, 450);
  const routes: [RegExp, () => Response][] = [
    ...Object.entries(overrides).map(([re, fn]) => [new RegExp(re), fn] as [RegExp, () => Response]),
    [/openlibrary\.org\/api\/books\?bibkeys=ISBN:9780441172719/, () => Response.json(JSON.parse(fixture("ol-books-data-9780441172719.json")))],
    [/openlibrary\.org\/api\/books\?/, () => Response.json({})],
    [/openlibrary\.org\/books\/OL59726263M\.json/, () => Response.json(JSON.parse(fixture("ol-edition-OL59726263M.json")))],
    [/openlibrary\.org\/works\/OL893414W\/editions\.json/, () => Response.json(JSON.parse(fixture("ol-editions-OL893414W.json")))],
    [/openlibrary\.org\/works\/OL893414W\.json/, () => Response.json(JSON.parse(fixture("ol-work-dune.json")))],
    [/openlibrary\.org\/search\.json/, () => Response.json(JSON.parse(fixture("ol-search-dune.json")))],
    [/covers\.openlibrary\.org\/b\/id\/15110282-L\.jpg/, () => new Response(new Blob([jpeg as BlobPart]), { headers: { "content-type": "image/jpeg" } })],
    [/api\.crossref\.org\/works\/10\.1145\/3290605\.3300857/, () => Response.json(JSON.parse(fixture("crossref-work-paper.json")))],
    [/api\.crossref\.org\/works\/10\.1093\/ajae\/aaq063/, () => Response.json(JSON.parse(fixture("crossref-work-paper.json")))],
    [/api\.crossref\.org\/works\?/, () => Response.json(JSON.parse(fixture("crossref-search-attention.json")))],
    [/api\.crossref\.org\/works\//, () => new Response("Resource not found.", { status: 404 })],
    [/doi\.org\/10\.48550\/arXiv\.1706\.03762/, () => Response.json(JSON.parse(fixture("doiorg-csl-arxiv.json")))],
    [/doi\.org\//, () => new Response("Not found", { status: 404 })],
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const hit = routes.find(([re]) => re.test(url));
    return hit ? hit[1]() : new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("normalization", () => {
  test("dates, series, languages, subjects", () => {
    expect(parseLooseDate("June 1990")).toBe("1990-06");
    expect(parseLooseDate("Aug 01, 2005")).toBe("2005-08-01");
    expect(parseLooseDate("1987")).toBe("1987");
    expect(parseLooseDate("2005-08-01")).toBe("2005-08-01");
    expect(parseSeries("Dune chronicles -- bk. 1")).toEqual({ series: "Dune chronicles", seriesIndex: 1 });
    expect(parseSeries("Foundation ; 2")).toEqual({ series: "Foundation", seriesIndex: 2 });
    expect(parseSeries("Discworld #5")).toEqual({ series: "Discworld", seriesIndex: 5 });
    expect(parseSeries("Penguin classics")).toEqual({ series: "Penguin classics", seriesIndex: null });
    expect(normalizeLanguage("/languages/eng")).toBe("en");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("ger")).toBe("de");
    expect(normalizeLanguage("tlh")).toBe("tlh");
    expect(cleanSubjects(["Fiction", "fiction.", "New York Times reviewed", "nyt:mass_market=2021", "Accessible book", "Space opera"])).toEqual(["Fiction", "Space opera"]);
  });
});

describe("sources (recorded responses)", () => {
  test("Open Library by ISBN: edition + edition record + work", async () => {
    const { fetchImpl, calls } = await fakeNetwork();
    const http = new HttpClient(null, () => null, { fetchImpl, sleep: noSleep });
    const c = (await openLibraryByIsbn(http, "9780441172719"))!;
    expect(c).toMatchObject({ source: "openlibrary", match: "isbn", olEditionKey: "OL59726263M", olWorkKey: "OL893414W", coverUrl: "https://covers.openlibrary.org/b/id/15110282-L.jpg" });
    expect(c.metadata).toMatchObject({ title: "Dune", authors: ["Frank Herbert"], isbn13: "9780441172719", publisher: "Ace", edition: "91st printing", publishedDate: "2020", pages: 896, language: "en" });
    expect(c.metadata.description).toStartWith("Set on the desert planet Arrakis");
    expect(c.metadata.tags).not.toContain("New York Times reviewed");
    expect(c.label).toBe("Open Library · Ace · 91st printing · 2020 · 896 pages");
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual(["/api/books", "/books/OL59726263M.json", "/works/OL893414W.json"]);
    expect(await openLibraryByIsbn(http, "9780131103627")).toBeNull();
  });

  test("Open Library search gives work-level candidates without ISBN", async () => {
    const { fetchImpl, calls } = await fakeNetwork();
    const http = new HttpClient(null, () => null, { fetchImpl, sleep: noSleep });
    const list = await openLibrarySearch(http, { title: "dune", author: "herbert" });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatchObject({ match: "search", olWorkKey: "OL893414W", metadata: { title: "Dune", authors: ["Frank Herbert"], isbn13: null, publishedDate: "1965" } });
    expect(new URL(calls[0]!.url).searchParams.get("title")).toBe("dune");
  });

  test("DOI: Crossref, then doi.org CSL for DataCite DOIs; book's DOI spelling kept", async () => {
    const { fetchImpl, calls } = await fakeNetwork();
    const http = new HttpClient(null, () => "me@example.org", { fetchImpl, sleep: noSleep });
    const paper = (await lookupDoi(http, "10.1145/3290605.3300857"))!;
    expect(paper.metadata).toMatchObject({ title: "Transformation through Provocation?", publisher: "ACM", publishedDate: "2019-05-02", doi: "10.1145/3290605.3300857" });
    expect(paper.metadata.authors).toHaveLength(6);
    expect(paper.metadata.authors[0]).toBe("Maria Roussou");
    expect(paper.label).toContain("proceedings article");
    expect(calls[0]!.url).toContain("mailto=me%40example.org");
    expect(calls[0]!.headers["user-agent"]).toContain("mailto:me@example.org");

    const arxiv = (await lookupDoi(http, "10.48550/arXiv.1706.03762"))!;
    expect(arxiv.metadata).toMatchObject({ title: "Attention Is All You Need", publisher: "arXiv", publishedDate: "2017", doi: "10.48550/arXiv.1706.03762" });
    expect(arxiv.metadata.authors).toHaveLength(8);
    expect(arxiv.metadata.description).toStartWith("The dominant sequence transduction models");
    expect(arxiv.label).toStartWith("DOI registry");
    expect(calls.some((c) => c.url.startsWith("https://doi.org/") && c.headers.accept === "application/vnd.citationstyles.csl+json")).toBe(true);
  });

  test("DOI with underscores from a filename: the all-slashes spelling is retried", async () => {
    const { fetchImpl, calls } = await fakeNetwork();
    const http = new HttpClient(null, () => null, { fetchImpl, sleep: noSleep });
    // The fake serves a recorded work for the all-slashes spelling only.
    expect((await lookupDoi(http, "10.1093/ajae_aaq063"))!.metadata.title).toBe("Transformation through Provocation?");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/works/10.1093/ajae_aaq063",
      "/10.1093/ajae_aaq063",
      "/works/10.1093/ajae/aaq063",
    ]);
    expect(await lookupDoi(http, "10.9999/nothing")).toBeNull();
  });
});

describe("HTTP client", () => {
  test("caches 200/404 in SQLite, retries 429 honouring Retry-After, throttles per host", async () => {
    let n = 0;
    const waits: number[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      n++;
      if (String(input).includes("busy") && n === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      return String(input).includes("missing") ? new Response("nope", { status: 404 }) : Response.json({ ok: n });
    }) as typeof fetch;
    const app = createApp(loadConfig({ data_dir: mkdtempSync(join(tmpdir(), "bookshelf-http-")) }));
    try {
      const http = new HttpClient(app.db, () => null, { fetchImpl, sleep: async (ms) => void waits.push(ms), minIntervalMs: 500 });
      expect(await http.getJson("https://x.test/busy")).toEqual({ ok: 2 });
      expect(waits).toContain(2000);
      expect(await http.getJson("https://x.test/busy")).toEqual({ ok: 2 }); // cached
      expect(await http.getJson("https://x.test/missing")).toBeNull();
      expect(await http.getJson("https://x.test/missing")).toBeNull();
      expect(n).toBe(3);
      expect(waits.filter((w) => w === 500).length).toBeGreaterThan(0);
    } finally {
      await app.library.close();
      app.db.close();
    }
  });
});

describe("lookup service", () => {
  let tmp: string;
  let root: string;
  let app: AppContext;
  let calls: Call[];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "bookshelf-lookup-"));
    root = join(tmp, "library");
    mkdirSync(join(root, "S"), { recursive: true });
    const net = await fakeNetwork();
    calls = net.calls;
    app = createApp(loadConfig({ data_dir: join(tmp, "data") }), {
      library: { debounceMs: 30, stableMs: 80, graceMs: 300 },
      http: { fetchImpl: net.fetchImpl, sleep: noSleep },
    });
  });
  afterEach(async () => {
    await app.library.close();
    app.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const put = (rel: string, content = rel) => writeFileSync(join(root, rel), content);
  const idOf = (rel: string) => app.library.index.get(rel)!.bookId;

  test("ISBN lookup → diff → apply selected fields + cover → confirmed, renamed if needed", async () => {
    put("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    await app.library.open(root);
    const id = idOf("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");

    const r = await app.lookup.lookup(id);
    expect(r.errors).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0]!;
    const status = Object.fromEntries(c.diff.map((d) => [d.field, d.status]));
    expect(status).toMatchObject({ title: "same", authors: "same", isbn13: "same", publisher: "fill", edition: "fill", pages: "fill", language: "fill", description: "fill", doi: "missing" });

    const applied = await app.lookup.apply(id, { candidate: c, fields: ["publisher", "edition", "pages", "language", "description", "doi"], cover: true });
    expect(applied.book).toMatchObject({ publisher: "Ace", edition: "91st printing", pages: 896, language: "en", confirmedSource: "openlibrary", olEditionKey: "OL59726263M", olWorkKey: "OL893414W", hasCover: true });
    expect(applied.renamed).toEqual([]);
    expect(app.books.get(id)!.coverSource).toBe("openlibrary");
    expect(calls.some((x) => x.url.includes("covers.openlibrary.org") && x.url.includes("default=false"))).toBe(true);

    // A second lookup now shows those fields as equal.
    const again = await app.lookup.lookup(id);
    expect(again.candidates[0]!.diff.find((d) => d.field === "publisher")!.status).toBe("same");
  });

  test("books without identifiers are searched in both sources; typed ISBN/DOI is exact", async () => {
    put("S/Dune -- Frank Herbert.epub");
    await app.library.open(root);
    const id = idOf("S/Dune -- Frank Herbert.epub");
    const r = await app.lookup.lookup(id);
    expect(r.candidates.every((c) => c.match === "search")).toBe(true);
    expect(new Set(r.candidates.map((c) => c.source))).toEqual(new Set(["openlibrary", "doi"]));

    const typed = await app.lookup.lookup(id, { q: "978-0-441-17271-9" });
    expect(typed.candidates.map((c) => c.match)).toEqual(["isbn"]);
    const onlyOl = await app.lookup.lookup(id, { source: "openlibrary" });
    expect(onlyOl.candidates.every((c) => c.source === "openlibrary")).toBe(true);
  });

  test("applying never clears fields, rejects foreign cover hosts, and renames on title change", async () => {
    put("S/Some Paper -- Someone -- doi 10.48550_arXiv.1706.03762.pdf");
    await app.library.open(root);
    const id = idOf("S/Some Paper -- Someone -- doi 10.48550_arXiv.1706.03762.pdf");
    const c = (await app.lookup.lookup(id)).candidates[0]!;
    expect(c.match).toBe("doi");

    const evil: MetadataCandidate = { ...c, coverUrl: "https://evil.example/x.jpg" };
    await expect(app.lookup.apply(id, { candidate: evil, fields: ["title"], cover: true })).rejects.toThrow(ValidationError);

    const r = await app.lookup.apply(id, { candidate: c, fields: ["title", "authors", "isbn13", "description"], cover: false });
    expect(r.book).toMatchObject({ title: "Attention Is All You Need", confirmedSource: "doi", isbn13: null });
    expect(r.book.authors).toHaveLength(8);
    expect(r.renamed[0]!.to).toBe("S/Ashish Vaswani et al. - Attention Is All You Need [10.48550_arXiv.1706.03762].pdf");
  });

  test("cover picker: own edition, then every edition of the same work (book's language first), then other works", async () => {
    put("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    await app.library.open(root);
    const id = idOf("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    await app.bookService.update(id, { language: "en" });

    const r = await app.lookup.findCovers(id);
    expect(r.errors).toEqual([]);
    const ids = r.options.map((o) => /\/b\/id\/(\d+)-L/.exec(o.coverUrl)![1]);
    expect(ids).toEqual([
      "15110282", // this edition (ISBN), listed once although it is also among the editions
      "15270053", "15166231", // English editions
      "15246488", "14841443", "11481354", // other languages / unknown, in Open Library's order; no-cover and -1 entries skipped
      "980253", "6976407", // other works from the search (sequels): work-level cover only
    ]);
    expect(r.options[0]).toMatchObject({ thisEdition: true, title: "Dune", authors: ["Frank Herbert"], isbn13: "9780441172719" });
    expect(r.options.filter((o) => o.thisEdition)).toHaveLength(1);
    expect(r.options[2]).toMatchObject({ url: "https://openlibrary.org/books/OL22597282M", details: "Ace Books · Ace ed. · 1987 · 535 pages", language: "en", authors: ["Frank Herbert"] });
    expect(r.options[3]!.details).toContain("Paperback");
    expect(r.options[3]!.language).toBe("ro");
    expect(calls.filter((x) => x.url.includes("/editions.json")).length).toBe(1); // the work is fetched once

    // A typed ISBN starts from that edition: no title search, but still all editions of its work.
    calls.length = 0;
    const typed = await app.lookup.findCovers(id, "978-0-441-17271-9");
    expect(typed.options.length).toBe(6);
    expect(calls.some((x) => x.url.includes("search.json"))).toBe(false);

    // Free text replaces the search; the first result's title picks the work to expand.
    const searched = await app.lookup.findCovers(id, "dune herbert");
    expect(searched.options.length).toBe(8);
    expect(searched.options.some((o) => o.thisEdition)).toBe(true); // marked by ISBN among the editions

    await expect(app.lookup.setCoverFromUrl(id, "https://evil.example/x.jpg")).rejects.toThrow(ValidationError);
    await expect(app.lookup.setCoverFromUrl(id, 42)).rejects.toThrow(ValidationError);

    const before = app.books.get(id)!.updatedAt;
    await Bun.sleep(5);
    await app.lookup.setCoverFromUrl(id, r.options[0]!.coverUrl);
    const after = app.books.get(id)!;
    expect(after.updatedAt).not.toBe(before); // the UI's cover cache-buster
    expect(after).toMatchObject({ hasCover: true, coverSource: "openlibrary", confirmedSource: "manual", publisher: null, pages: null });
  });

  test("bulk lookup fills the review queue; accept-fills only applies identifier matches", async () => {
    put("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    put("S/Mystery -- Nobody.epub");
    await app.library.open(root);
    const dune = idOf("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    const mystery = idOf("S/Mystery -- Nobody.epub");
    const events: string[] = [];
    app.events.subscribe((e) => e.type === "lookup.status" && events.push(JSON.stringify(e.status)));

    expect(app.lookup.enqueue([dune, mystery, dune]).pending).toBeLessThanOrEqual(2);
    await app.lookup.idle();
    expect(app.lookup.status()).toMatchObject({ running: false, pending: 0, done: 2, reviewCount: 2 });
    expect(events.length).toBeGreaterThan(0);

    const queue = app.lookup.reviewQueue();
    expect(queue.map((q) => q.book.id).sort()).toEqual([dune, mystery].sort());

    const res = await app.lookup.acceptAllFills();
    expect(res).toEqual({ applied: 1, skipped: 1, errors: [] });
    expect(app.books.get(dune)).toMatchObject({ publisher: "Ace", confirmedSource: "openlibrary", hasCover: true });
    expect(app.books.get(mystery)!.confirmedSource).toBeNull();
    expect(app.lookup.reviewQueue().map((q) => q.book.id)).toEqual([mystery]);

    app.lookup.removeFromQueue(mystery);
    expect(app.lookup.status().reviewCount).toBe(0);
  });

  test("network failures are reported, not thrown; bulk counts them", async () => {
    const failing = createApp(loadConfig({ data_dir: join(tmp, "data2") }), {
      library: { debounceMs: 30, stableMs: 80, graceMs: 300 },
      http: { fetchImpl: (async () => { throw new Error("ENETUNREACH"); }) as unknown as typeof fetch, sleep: noSleep, retries: 1 },
    });
    try {
      put("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
      await failing.library.open(root);
      const id = failing.library.index.get("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub")!.bookId;
      const r = await failing.lookup.lookup(id);
      expect(r.candidates).toEqual([]);
      expect(r.errors.join(" ")).toContain("ENETUNREACH");
      failing.lookup.enqueue([id]);
      await failing.lookup.idle();
      expect(failing.lookup.status()).toMatchObject({ failed: 1, reviewCount: 0 });
    } finally {
      await failing.library.close();
      failing.db.close();
    }
  });

  test("HTTP endpoints", async () => {
    put("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    await app.library.open(root);
    const id = idOf("S/Dune -- Frank Herbert -- isbn13 9780441172719.epub");
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const lookup = await fetch(`${server.url}api/lookup/${id}`);
      expect(lookup.status).toBe(200);
      const { candidates } = await lookup.json();
      expect((await fetch(`${server.url}api/lookup/${id}?source=amazon`)).status).toBe(400);
      const applied = await fetch(`${server.url}api/books/${id}/apply-metadata`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidate: candidates[0], fields: ["pages"], cover: false }),
      });
      expect(applied.status).toBe(200);
      expect((await applied.json()).book.pages).toBe(896);
      const covers = await (await fetch(`${server.url}api/lookup/${id}/covers?q=Dune`)).json();
      expect(covers.options.length).toBe(8);
      const setCover = await fetch(`${server.url}api/books/${id}/cover/from-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: candidates[0].coverUrl }),
      });
      expect(setCover.status).toBe(200);
      expect((await setCover.json()).hasCover).toBe(true);
      const bad = await fetch(`${server.url}api/books/${id}/cover/from-url`, { method: "POST", body: JSON.stringify({ url: "http://covers.openlibrary.org/x.jpg" }) });
      expect(bad.status).toBe(400);
      expect((await fetch(`${server.url}api/lookup/bulk`, { method: "POST", body: JSON.stringify({ ids: [id] }) })).status).toBe(202);
      await app.lookup.idle();
      expect(((await (await fetch(`${server.url}api/review-queue`)).json()) as unknown[]).length).toBe(1);
      expect((await (await fetch(`${server.url}api/lookup/status`)).json()).reviewCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
