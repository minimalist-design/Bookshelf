import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import type { AppContext } from "../src/server/app.ts";
import { displayOrder, editDistance, foldKey, groupNames, relation, shapeKey } from "../src/server/cleanup/similarity.ts";
import { ValidationError } from "../src/server/library/paths.ts";
import type { CleanupField, MetadataCandidate } from "../src/shared/types.ts";
import * as bookRepo from "../src/server/db/repo/books.ts";
import * as lookups from "../src/server/services/lookup/lookup.ts";
import * as books from "../src/server/services/books.ts";
import * as cleanup from "../src/server/services/cleanup.ts";
import { closeTestApp, scratchDir, SLOW_RETENTION, testApp } from "./fixtures.ts";

const facets = (...pairs: [string, number][]) => pairs.map(([name, count]) => ({ name, count }));

describe("similar spellings", () => {
  test("keys: case, accents and spacing fold; punctuation and name order shape", () => {
    expect(foldKey("  KURT   Gödel ")).toBe("kurt godel");
    expect(shapeKey("Tolkien, J. R. R.", "authors")).toBe(shapeKey("J.R.R. Tolkien", "authors"));
    expect(shapeKey("O'Brien, Flann", "authors")).toBe(shapeKey("Flann OBrien", "authors"));
    expect(shapeKey("Science-Fiction", "tags")).toBe("science fiction");
    expect(displayOrder("Tolkien, J. R. R.")).toBe("J. R. R. Tolkien");
    expect(displayOrder("austen, jane")).toBe("jane austen");
    expect(displayOrder("King, Martin Luther, Jr.")).toBe("Martin Luther King Jr.");
    expect(displayOrder("Martin Luther King, Jr.")).toBe("Martin Luther King, Jr.");
    expect(editDistance("austen", "austin")).toBe(1);
    expect(editDistance("dostoevsky", "dostoyevsky")).toBe(1);
    expect(editDistance("ab", "ba")).toBe(1); // a swap is one edit
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3); // gives up past the limit
  });

  test("relations, strongest first; initials only for authors", () => {
    expect(relation("Jane Austen", "JANE AUSTEN", "authors")).toBe("case");
    expect(relation("Jane Austen", "Austen, Jane", "authors")).toBe("punctuation");
    expect(relation("Jane Austen", "Jane Austin", "authors")).toBe("typo");
    expect(relation("Jane Austen", "J. Austen", "authors")).toBe("initials");
    expect(relation("J. R. R. Tolkien", "John Ronald Reuel Tolkien", "authors")).toBe("initials");
    expect(relation("Martin Luther King Jr.", "King, Martin Luther, Jr.", "authors")).toBe("punctuation");
    expect(relation("John Smith", "Jane Smith", "authors")).toBeNull();
    expect(relation("Frank Herbert", "Brian Herbert", "authors")).toBeNull();
    expect(relation("J. Austen", "J. Austen", "tags")).toBe("case");
    expect(relation("SF", "YA", "tags")).toBeNull(); // too short for typos
  });

  test("groups: main name is the most used, variants sorted by match, only safe ones ticked", () => {
    const { groups, singles } = groupNames(
      facets(["JANE AUSTEN", 2], ["Jane Austen", 3], ["Austen, Jane", 1], ["Jane Austin", 1], ["J. Austen", 1], ["John Smith", 1], ["Jane Smith", 1]),
      "authors",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main).toBe("Jane Austen");
    expect(groups[0]!.variants.map((v) => [v.name, v.match, v.preselected, v.books])).toEqual([
      ["Jane Austen", "main", true, 3],
      ["JANE AUSTEN", "case", true, 2],
      ["Austen, Jane", "punctuation", true, 1],
      ["Jane Austin", "typo", false, 1],
      ["J. Austen", "initials", false, 1],
    ]);
    expect(singles.map((s) => s.name)).toEqual(["Jane Smith", "John Smith"]);
  });

  test("on equal use, a well-cased, comma-less spelling is the main name; certain groups come first", () => {
    const { groups } = groupNames(
      facets(["FYODOR DOSTOEVSKY", 1], ["Fyodor Dostoyevsky", 1], ["King, Martin Luther, Jr.", 1], ["Martin Luther King Jr.", 1]),
      "authors",
    );
    expect(groups.map((g) => g.main)).toEqual(["Martin Luther King Jr.", "Fyodor Dostoyevsky"]);
  });

  test("on equal use, the spelling most others are safe variants of wins over initials", () => {
    const { groups } = groupNames(facets(["J. Austen", 1], ["JANE AUSTEN", 1], ["Jane Austen", 1], ["Jane Austin", 1]), "authors");
    expect(groups[0]!.main).toBe("Jane Austen");
    expect(groups[0]!.variants.filter((v) => v.preselected).map((v) => v.name)).toEqual(["Jane Austen", "JANE AUSTEN"]);
  });
});

/** Open Library's author search response format (fields as requested). */
const AUTHOR_SEARCH = {
  numFound: 2,
  docs: [
    { key: "OL21594A", name: "Jane Austen", alternate_names: ["JANE AUSTEN", "Austen, Jane"], birth_date: "16 December 1775", death_date: "18 July 1817", top_work: "Pride and Prejudice", work_count: 3254 },
    { key: "OL123A", name: "Jane  Austen ", top_work: "A Study", work_count: 1 },
    { name: "No key" },
  ],
};

/**
 * Wikidata's name search (wbsearchentities) and the query service's answer for the people among the
 * hits. Q1 is a novel, not a person: the query service leaves it out. Q999 is a person no library knows.
 */
const WIKIDATA_SEARCH = {
  search: [
    { id: "Q999", label: "Jane Austen", description: "British athlete", match: { type: "label", text: "Jane Austen" } },
    { id: "Q1", label: "Jane Austen", description: "novel" },
    { id: "Q36322", label: "Jane Austen", display: { label: { value: "Jane Austen" }, description: { value: "English novelist (1775–1817)" } }, match: { type: "alias", text: "Austen, Jane" } },
  ],
};
const WIKIDATA_PEOPLE = {
  results: {
    bindings: [
      { item: { value: "http://www.wikidata.org/entity/Q999" }, birth: { value: "1990-01-01T00:00:00Z" } },
      {
        item: { value: "http://www.wikidata.org/entity/Q36322" },
        birth: { value: "1775-12-16T00:00:00Z" },
        death: { value: "1817-07-18T00:00:00Z" },
        P244: { value: "n79032879" },
        P227: { value: "118505165" },
        P648: { value: "OL21594A" },
      },
    ],
  },
};

describe("name cleanup service", () => {
  let tmp: string;
  let root: string;
  let app: AppContext;
  let urls: string[];
  /** How the fake Wikidata behaves. */
  let wikidata: "ok" | "empty" | "down";

  beforeEach(() => {
    ({ tmp, root } = scratchDir("cleanup", ["S"]));
    urls = [];
    wikidata = "ok";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (/search\/authors\.json/.test(url)) return Response.json(AUTHOR_SEARCH);
      if (/wikidata\.org/.test(url) && wikidata === "down") return new Response("down", { status: 503 });
      if (/www\.wikidata\.org\/w\/api\.php/.test(url)) return Response.json(wikidata === "empty" ? { search: [] } : WIKIDATA_SEARCH);
      if (/query\.wikidata\.org\/sparql/.test(url)) return Response.json(WIKIDATA_PEOPLE);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    app = testApp(tmp, {}, { library: SLOW_RETENTION, http: { fetchImpl, sleep: async () => {} } });
  });

  afterEach(() => closeTestApp(app, tmp));

  const put = (rel: string) => writeFileSync(join(root, rel), rel);
  const idOf = (rel: string) => app.library.index.get(rel)!.bookId;
  const filesOf = (id: number) => app.library.index.filesOfBook(id).map((f) => f.relPath);

  test("merging authors rewrites every book, renames files, keeps confirmation, and remembers the spelling", async () => {
    put("S/Emma -- JANE AUSTEN.epub");
    put("S/Persuasion -- Austen, Jane.epub");
    put("S/Sanditon -- Jane Austen.epub");
    await app.library.open(root);
    const emma = idOf("S/Emma -- JANE AUSTEN.epub");
    const persuasion = idOf("S/Persuasion -- Austen, Jane.epub");
    const sanditon = idOf("S/Sanditon -- Jane Austen.epub");
    // Persuasion is confirmed (a manual edit) and lists two spellings that will become one.
    await books.update(app, persuasion, { authors: ["Jane Austin", "Jane Austen"] });

    const before = await cleanup.groups(app, "authors");
    expect(before.groups.map((g) => g.variants.map((v) => v.name))).toEqual([["Jane Austen", "JANE AUSTEN", "Jane Austin"]]);
    // Each spelling lists the books that use it, by title.
    expect(await cleanup.booksWithName(app, "authors", "Jane Austen")).toEqual([
      { id: persuasion, title: "Persuasion", authors: ["Jane Austin", "Jane Austen"] },
      { id: sanditon, title: "Sanditon", authors: ["Jane Austen"] },
    ]);
    expect((await cleanup.booksWithName(app, "authors", "JANE AUSTEN")).map((b) => b.id)).toEqual([emma]);
    await expect(cleanup.booksWithName(app, "genres", "x")).rejects.toThrow(ValidationError);

    const r = await cleanup.merge(app, "authors", ["JANE AUSTEN", "Jane Austin"], "Jane Austen");
    expect(r).toMatchObject({ books: 2, errors: [] });
    expect(r.renamed.map((x) => x.to).sort()).toEqual(["S/Jane Austen - Emma.epub", "S/Jane Austen - Persuasion.epub"]);
    expect(bookRepo.get(app.db, emma)).toMatchObject({ authors: ["Jane Austen"], confirmedSource: null });
    expect(bookRepo.get(app.db, persuasion)).toMatchObject({ authors: ["Jane Austen"], confirmedSource: "manual" });
    expect(bookRepo.get(app.db, sanditon)!.authors).toEqual(["Jane Austen"]);
    expect(filesOf(emma)).toEqual(["S/Jane Austen - Emma.epub"]);
    expect(existsSync(join(root, "S/Jane Austen - Emma.epub"))).toBe(true);
    expect((await cleanup.groups(app, "authors")).groups).toEqual([]);
    expect(cleanup.listAliases(app)).toEqual([
      { field: "authors", variant: "JANE AUSTEN", canonical: "Jane Austen" },
      { field: "authors", variant: "Jane Austin", canonical: "Jane Austen" },
    ]);

    // A new file with an old spelling (or another case of it) comes in with the main name.
    put("S/Lady Susan -- JANE AUSTEN.epub");
    put("S/Love and Freindship -- jane austin.epub");
    await app.library.rescan();
    expect(bookRepo.get(app.db, idOf("S/Lady Susan -- JANE AUSTEN.epub"))!.authors).toEqual(["Jane Austen"]);
    expect(bookRepo.get(app.db, idOf("S/Love and Freindship -- jane austin.epub"))!.authors).toEqual(["Jane Austen"]);
  });

  test("aliases never chain, apply to any case of a known spelling, and can be forgotten", async () => {
    put("S/A -- Ann Radcliffe.epub");
    await app.library.open(root);
    await cleanup.merge(app, "authors", ["Ann Radcliffe"], "Anne Radcliffe");
    await cleanup.merge(app, "authors", ["Anne Radcliffe"], "Ann Ward Radcliffe");
    expect(cleanup.listAliases(app).map((a) => [a.variant, a.canonical])).toEqual([
      ["Ann Radcliffe", "Ann Ward Radcliffe"],
      ["Anne Radcliffe", "Ann Ward Radcliffe"],
    ]);
    const meta = { authors: ["ANN RADCLIFFE", "ann ward radcliffe", "Someone"], tags: [], series: null, publisher: null };
    expect(app.aliases.apply(meta).authors).toEqual(["Ann Ward Radcliffe", "Someone"]);

    cleanup.removeAlias(app, "authors", "Ann Radcliffe");
    expect(app.aliases.apply(meta).authors).toEqual(["ANN RADCLIFFE", "Ann Ward Radcliffe", "Someone"]);
    expect(() => cleanup.removeAlias(app, "genres", "x")).toThrow(ValidationError);
  });

  test("tags (stored without case), series and publishers merge too", async () => {
    put("S/One -- Someone.epub");
    put("S/Two -- Someone.epub");
    await app.library.open(root);
    const [one, two] = [idOf("S/One -- Someone.epub"), idOf("S/Two -- Someone.epub")];
    await books.update(app, one, { tags: ["science fiction", "Space"], series: "Dune Chronicles", publisher: "ACE" });
    await books.update(app, two, { tags: ["Science-Fiction"], series: "dune chronicles", publisher: "Ace Books" });

    const tagGroups = await cleanup.groups(app, "tags");
    expect(tagGroups.groups[0]!.variants.map((v) => v.name).sort()).toEqual(["Science-Fiction", "science fiction"]);
    expect(tagGroups.singles).toEqual([]); // lone names are only listed for authors

    const merges: [CleanupField, string[], string][] = [
      ["tags", ["science fiction", "Science-Fiction"], "Science Fiction"],
      ["series", ["dune chronicles"], "Dune Chronicles"],
      ["publishers", ["ACE", "Ace Books"], "Ace"],
    ];
    for (const [field, from, to] of merges) await cleanup.merge(app, field, from, to);
    expect(bookRepo.get(app.db, one)).toMatchObject({ tags: ["Science Fiction", "Space"], series: "Dune Chronicles", publisher: "Ace" });
    expect(bookRepo.get(app.db, two)).toMatchObject({ tags: ["Science Fiction"], series: "Dune Chronicles", publisher: "Ace" });

    await expect(cleanup.merge(app, "authors", [], "X")).rejects.toThrow(ValidationError);
    await expect(cleanup.merge(app, "authors", ["A"], "  ")).rejects.toThrow(ValidationError);
    await expect(cleanup.groups(app, "genres")).rejects.toThrow(ValidationError);
  });

  test("lookup candidates use the remembered spelling, so they match the book", async () => {
    put("S/Dune -- Frank Herbert.epub");
    await app.library.open(root);
    const id = idOf("S/Dune -- Frank Herbert.epub");
    await cleanup.merge(app, "authors", ["FRANK HERBERT"], "Frank Herbert");
    const candidate = (authors: string[]): MetadataCandidate => ({
      source: "openlibrary",
      match: "search",
      id: "OL1W",
      url: "https://openlibrary.org/works/OL1W",
      label: "",
      metadata: { title: "Dune", subtitle: null, authors, isbn13: null, doi: null, publisher: null, edition: null, publishedDate: null, language: null, pages: null, description: null, series: null, seriesIndex: null, tags: [] },
      coverUrl: null,
      olEditionKey: null,
      olWorkKey: "OL1W",
    });
    // A lookup result reached through the review queue's stored payload goes through the same path.
    app.db.query("INSERT INTO review_queue (book_id, payload) VALUES (?, ?)").run(id, JSON.stringify([candidate(["FRANK HERBERT"])]));
    const [item] = lookups.reviewItems(app);
    expect(item!.result.candidates[0]!.metadata.authors).toEqual(["Frank Herbert"]);
    expect(item!.result.candidates[0]!.diff.find((d) => d.field === "authors")!.status).toBe("same");
  });

  test("author search: Wikidata's people, those known to libraries first; Open Library as the fallback", async () => {
    const found = await cleanup.searchAuthors(app, "jane austen");
    expect(found).toEqual({
      source: "wikidata",
      note: null,
      matches: [
        {
          source: "wikidata",
          key: "Q36322",
          name: "Jane Austen",
          years: "1775–1817",
          description: "English novelist (1775–1817)",
          topWork: null,
          workCount: null,
          alternateNames: ["Austen, Jane"],
          authorities: [
            { name: "Library of Congress", url: "https://id.loc.gov/authorities/names/n79032879.html" },
            { name: "GND", url: "https://d-nb.info/gnd/118505165" },
            { name: "Open Library", url: "https://openlibrary.org/authors/OL21594A" },
          ],
          url: "https://www.wikidata.org/wiki/Q36322",
        },
        expect.objectContaining({ key: "Q999", years: "1990–", authorities: [] }),
      ],
    });
    // The query service is only asked about the search hits, and only for people.
    const sparql = new URL(urls.find((u) => u.includes("query.wikidata.org"))!).searchParams.get("query")!;
    expect(sparql).toContain("wd:Q999 wd:Q1 wd:Q36322");
    expect(sparql).toContain("wd:Q5");

    wikidata = "empty";
    expect(await cleanup.searchAuthors(app, "jane austin")).toMatchObject({
      source: "openlibrary",
      note: "No person called “jane austin” on Wikidata.",
      matches: [expect.objectContaining({ key: "OL21594A", source: "openlibrary" }), expect.anything()],
    });
    wikidata = "down";
    const down = await cleanup.searchAuthors(app, "j. austen");
    expect(down.source).toBe("openlibrary");
    expect(down.note).toStartWith("Wikidata could not be reached");

    // Open Library by hand, even when Wikidata has matches.
    wikidata = "ok";
    expect((await cleanup.searchAuthors(app, "jane austen", "openlibrary")).source).toBe("openlibrary");
    await expect(cleanup.searchAuthors(app, "jane austen", "google")).rejects.toThrow(ValidationError);
  });

  test("swapped titles and authors are found, with a fix read from the filename where possible, and fixed", async () => {
    put("S/A gentle introduction to category theory T - Fokkinga M M.pdf");
    put("S/Pride and Prejudice - Jane Austen.epub");
    put("S/The Long Road Home - Jane Doe [9780262510875].epub"); // app-written order: read as author - title
    put("S/The Quiet Sea - John Roe [9780131103627].epub");
    put("S/Emma -- Jane Austen.epub");
    await app.library.open(root);
    const gentle = idOf("S/A gentle introduction to category theory T - Fokkinga M M.pdf");
    const pride = idOf("S/Pride and Prejudice - Jane Austen.epub");
    const road = idOf("S/The Long Road Home - Jane Doe [9780262510875].epub");
    const sea = idOf("S/The Quiet Sea - John Roe [9780131103627].epub");
    // New files are read the right way round…
    expect(bookRepo.get(app.db, gentle)).toMatchObject({ title: "A gentle introduction to category theory T", authors: ["M. M. Fokkinga"] });
    expect(bookRepo.get(app.db, pride)).toMatchObject({ title: "Pride and Prejudice", authors: ["Jane Austen"] });
    // …but books stored by the old reading are still swapped, and so are names with an ID.
    const store = (id: number, title: string, authors: string[]) => bookRepo.updateMetadata(app.db, id, { ...bookRepo.get(app.db, id)!, title, authors }, null);
    store(gentle, "Fokkinga M M", ["A gentle introduction to category theory T"]);
    store(pride, "Jane Austen", ["Pride", "Prejudice"]);
    expect(bookRepo.get(app.db, road)).toMatchObject({ title: "Jane Doe", authors: ["The Long Road Home"] });
    bookRepo.confirm(app.db, sea, "manual"); // confirmed books are left alone

    const suspects = await cleanup.swapSuspects(app);
    expect(suspects.map((s) => [s.id, s.basis, s.proposed])).toEqual([
      [gentle, "filename", { title: "A gentle introduction to category theory T", authors: ["M. M. Fokkinga"] }],
      [pride, "filename", { title: "Pride and Prejudice", authors: ["Jane Austen"] }],
      [road, "swap", { title: "The Long Road Home", authors: ["Jane Doe"] }],
    ]);
    expect(suspects[0]!.files).toEqual(["S/A gentle introduction to category theory T - Fokkinga M M.pdf"]);

    await expect(cleanup.fixTitleAuthor(app, [])).rejects.toThrow(ValidationError);
    await expect(cleanup.fixTitleAuthor(app, [{ id: road, title: " ", authors: [] }])).rejects.toThrow(ValidationError);
    const r = await cleanup.fixTitleAuthor(app, suspects.map((s) => ({ id: s.id, ...s.proposed })));
    expect(r).toMatchObject({ books: 3, errors: [] });
    expect(bookRepo.get(app.db, road)).toMatchObject({ title: "The Long Road Home", authors: ["Jane Doe"], confirmedSource: null });
    expect(filesOf(road)).toEqual(["S/Jane Doe - The Long Road Home [9780262510875].epub"]);
    expect(filesOf(gentle)).toEqual(["S/M. M. Fokkinga - A gentle introduction to category theory T.pdf"]);
    expect(await cleanup.swapSuspects(app)).toEqual([]);
  });

  test("HTTP endpoints, including the author search", async () => {
    put("S/Emma -- JANE AUSTEN.epub");
    put("S/Sanditon -- Jane Austen.epub");
    await app.library.open(root);
    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    const call = (path: string, init?: RequestInit) => fetch(`${server.url}${path}`, init);
    try {
      const groups = await (await call("api/cleanup/groups?field=authors")).json();
      expect(groups.groups[0].main).toBe("Jane Austen");
      expect((await call("api/cleanup/groups?field=genres")).status).toBe(400);
      const named = await (await call("api/cleanup/books?field=authors&name=JANE%20AUSTEN")).json();
      expect(named.map((b: { title: string }) => b.title)).toEqual(["Emma"]);
      expect((await call("api/cleanup/books?field=authors")).status).toBe(400);

      expect((await (await call("api/cleanup/author-search?q=jane%20austen")).json()).source).toBe("wikidata");
      const ol = await (await call("api/cleanup/author-search?q=jane%20austen&source=openlibrary")).json();
      expect(ol.matches).toEqual([
        { source: "openlibrary", key: "OL21594A", name: "Jane Austen", years: "1775–1817", description: null, topWork: "Pride and Prejudice", workCount: 3254, alternateNames: ["JANE AUSTEN", "Austen, Jane"], authorities: [], url: "https://openlibrary.org/authors/OL21594A" },
        { source: "openlibrary", key: "OL123A", name: "Jane Austen", years: null, description: null, topWork: "A Study", workCount: 1, alternateNames: [], authorities: [], url: "https://openlibrary.org/authors/OL123A" },
      ]);
      expect(urls.some((u) => u.includes("openlibrary.org/search/authors.json?q=jane+austen"))).toBe(true);
      expect((await call("api/cleanup/author-search?q=x&source=google")).status).toBe(400);

      const merged = await call("api/cleanup/merge", { method: "POST", body: JSON.stringify({ field: "authors", from: ["JANE AUSTEN"], to: "Jane Austen" }) });
      expect(merged.status).toBe(200);
      expect((await merged.json()).books).toBe(1);
      expect(await (await call("api/cleanup/aliases")).json()).toEqual([{ field: "authors", variant: "JANE AUSTEN", canonical: "Jane Austen" }]);
      const removed = await call("api/cleanup/aliases", { method: "DELETE", body: JSON.stringify({ field: "authors", variant: "JANE AUSTEN" }) });
      expect(await removed.json()).toEqual([]);

      const sanditon = idOf("S/Sanditon -- Jane Austen.epub");
      bookRepo.updateMetadata(app.db, sanditon, { ...bookRepo.get(app.db, sanditon)!, title: "Jane Austen", authors: ["The Watsons and Other Stories"] }, null);
      const swaps = await (await call("api/cleanup/swaps")).json();
      expect(swaps.map((s: { id: number }) => s.id)).toEqual([sanditon]);
      expect((await call("api/cleanup/swaps", { method: "POST", body: JSON.stringify({ items: "x" }) })).status).toBe(400);
      const fixed = await call("api/cleanup/swaps", { method: "POST", body: JSON.stringify({ items: [{ id: sanditon, ...swaps[0].proposed }] }) });
      expect((await fixed.json()).books).toBe(1);
      expect(bookRepo.get(app.db, sanditon)).toMatchObject({ title: "The Watsons and Other Stories", authors: ["Jane Austen"] });
    } finally {
      server.stop(true);
    }
  });
});
