import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReferenceDb,
  completeReferenceDb,
  createReferenceSchema,
  rawBodyText,
  readMeta,
  SCHEMA_COLUMNS,
  setMeta,
  storeRawResponse,
} from "../src/server/reference/format.ts";
import * as referenceStore from "../src/server/reference/store.ts";
import { apiRoutes } from "../src/server/api/router.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import {
  editionRows,
  entityRows,
  personRows,
  references,
  responseEntities,
  responseRedirects,
  timeToDate,
  timeToYear,
  workRows,
  type Entity,
  type Statement,
} from "../scripts/wikidata/wikidata.ts";
import { BUILD_SCHEMA, classifyAnswer, normalize, retryWaitSeconds } from "../scripts/wikidata/build.ts";
import { mergeRows as mergeEntityRows } from "../scripts/wikidata/wikidata.ts";

// ---------------------------------------------------------------- Wikidata JSON fixtures

const item = (id: string, extra: Partial<Statement> = {}): Statement => ({
  mainsnak: { snaktype: "value", datavalue: { type: "wikibase-entityid", value: { id } } },
  rank: "normal",
  ...extra,
});
const str = (value: string, rank: Statement["rank"] = "normal"): Statement => ({ mainsnak: { snaktype: "value", datavalue: { type: "string", value } }, rank });
const mono = (text: string, language: string): Statement => ({ mainsnak: { snaktype: "value", datavalue: { type: "monolingualtext", value: { text, language } } }, rank: "normal" });
const time = (t: string, precision: number): Statement => ({ mainsnak: { snaktype: "value", datavalue: { type: "time", value: { time: t, precision } } }, rank: "normal" });
const qty = (amount: string): Statement => ({ mainsnak: { snaktype: "value", datavalue: { type: "quantity", value: { amount, unit: "1" } } }, rank: "normal" });
const labels = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([language, value]) => [language, { language, value }]));

const dostoyevsky: Entity = {
  id: "Q991",
  labels: labels({ en: "Fyodor Dostoyevsky", ru: "Фёдор Михайлович Достоевский", es: "Fiódor Dostoyevski" }),
  descriptions: labels({ en: "Russian novelist (1821–1881)" }),
  aliases: { en: [{ language: "en", value: "Fyodor Dostoevsky" }, { language: "en", value: "F. M. Dostoevsky" }], de: [{ language: "de", value: "Fjodor Dostojewski" }] },
  claims: {
    P31: [item("Q5")],
    P569: [time("+1821-11-11T00:00:00Z", 11)],
    P570: [time("+1881-02-09T00:00:00Z", 11)],
    P742: [str("D.")],
    P1559: [mono("Фёдор Достоевский", "ru")],
    P648: [str("OL22242A")],
    P213: [str("0000 0001 2124 3768")],
    P214: [str("104722166", "deprecated")],
  },
  sitelinks: { enwiki: {}, ruwiki: {}, eswiki: {} },
};

const crimeAndPunishment: Entity = {
  id: "Q160534",
  labels: labels({ en: "Crime and Punishment", ru: "Преступление и наказание" }),
  aliases: { en: [{ language: "en", value: "Crime & Punishment" }] },
  claims: {
    P50: [item("Q991")],
    P110: [item("Q500")],
    P1476: [mono("Преступление и наказание", "ru")],
    P577: [time("+1867-00-00T00:00:00Z", 9), time("+1866-01-00T00:00:00Z", 10)],
    P179: [item("Q900", { qualifiers: { P1545: [{ snaktype: "value", datavalue: { type: "string", value: "9" } }] } })],
    P747: [item("Q777")],
    P648: [str("OL166894W")],
  },
  sitelinks: { enwiki: {} },
};

const edition: Entity = {
  id: "Q777",
  labels: labels({ en: "Crime and Punishment (Penguin, 2003)" }),
  claims: {
    P629: [item("Q160534")],
    P1476: [mono("Crime and Punishment", "en")],
    P655: [item("Q600")],
    P123: [item("Q1")],
    P577: [time("+2003-01-30T00:00:00Z", 11)],
    P1104: [qty("+671")],
    P212: [str("978-0-14-044913-6")],
    P957: [str("0-14-044913-x")],
  },
};

describe("Wikidata entities to reference rows", () => {
  test("a person: display name, every name in the kept languages (mul and unknown always), years, prominence, identifiers", () => {
    const rows = personRows(dostoyevsky, new Set(["en", "ru"]));
    expect(rows.authors).toEqual([
      { id: "Q991", name: "Fyodor Dostoyevsky", sort_name: null, description: "Russian novelist (1821–1881)", birth_year: 1821, death_year: 1881, prominence: 3 },
    ]);
    expect(rows.author_names!.map((n) => `${n.kind}:${n.lang}:${n.name}`).sort()).toEqual([
      "alias:en:F. M. Dostoevsky",
      "alias:en:Fyodor Dostoevsky",
      "name:en:Fyodor Dostoyevsky",
      "name:ru:Фёдор Михайлович Достоевский",
      "native:ru:Фёдор Достоевский",
      "pseudonym::D.",
    ]);
    // ISNI without spaces; the deprecated VIAF statement is left out.
    expect(rows.identifiers).toEqual([
      { entity: "author", entity_id: "Q991", scheme: "openlibrary", value: "OL22242A" },
      { entity: "author", entity_id: "Q991", scheme: "isni", value: "0000000121243768" },
    ]);
    // Every language when none is chosen.
    expect(personRows(dostoyevsky, null).author_names!.some((n) => n.lang === "de")).toBe(true);
  });

  test("a work: titles in every language next to each other, earliest publication, series number, credits in order", () => {
    const rows = workRows(crimeAndPunishment, null);
    expect(rows.works).toEqual([
      { id: "Q160534", title: "Crime and Punishment", description: null, first_year: 1866, original_lang: "ru", series_id: "Q900", series_index: 9, prominence: 1 },
    ]);
    expect(rows.work_titles!.map((t) => `${t.kind}:${t.lang}:${t.title}`).sort()).toEqual([
      "alias:en:Crime & Punishment",
      "original:ru:Преступление и наказание",
      "title:en:Crime and Punishment",
      "title:ru:Преступление и наказание",
    ]);
    expect(rows.work_authors).toEqual([
      { work_id: "Q160534", author_id: "Q991", role: "author", position: 0 },
      { work_id: "Q160534", author_id: "Q500", role: "illustrator", position: 1 },
    ]);
  });

  test("an edition: its work, publisher by name, date as precise as known, pages, ISBNs written to compare", () => {
    const rows = editionRows(edition, (id) => (id === "Q1" ? "Penguin Books" : null));
    expect(rows.editions).toEqual([
      {
        id: "Q777",
        work_id: "Q160534",
        title: "Crime and Punishment",
        subtitle: null,
        publisher: "Penguin Books",
        published_date: "2003-01-30",
        year: 2003,
        lang: "en",
        pages: 671,
        binding: null,
        description: null,
      },
    ]);
    expect(rows.edition_authors).toEqual([{ edition_id: "Q777", author_id: "Q600", role: "translator", position: 0 }]);
    expect(rows.identifiers!.map((i) => `${i.scheme}:${i.value}`)).toEqual(["isbn13:9780140449136", "isbn10:014044913X"]);
  });

  test("what an entity refers to is fetched in the right role", () => {
    expect(references(crimeAndPunishment, "work")).toEqual([
      { id: "Q991", role: "person" },
      { id: "Q500", role: "person" },
      { id: "Q900", role: "series" },
      { id: "Q777", role: "edition" },
    ]);
    expect(references(edition, "edition")).toContainEqual({ id: "Q1", role: "publisher" });
    expect(references(dostoyevsky, "person")).toEqual([]);
  });

  test("record_sources says which response the rows came from; publishers make no rows", () => {
    expect(entityRows(dostoyevsky, "person", null, () => null, 7).record_sources).toEqual([{ entity: "author", entity_id: "Q991", response_id: 7 }]);
    expect(entityRows({ id: "Q1", labels: labels({ en: "Penguin" }) }, "publisher", null, () => null, 7)).toEqual({});
  });

  test("dates and years, before the common era too; vaguer than a year is no date", () => {
    expect(timeToDate({ time: "+1866-01-00T00:00:00Z", precision: 10 })).toBe("1866-01");
    expect(timeToDate({ time: "-0428-00-00T00:00:00Z", precision: 9 })).toBe("-0428");
    expect(timeToYear({ time: "-0428-00-00T00:00:00Z", precision: 9 })).toBe(-428);
    expect(timeToYear({ time: "+1800-00-00T00:00:00Z", precision: 7 })).toBeNull();
  });

  test("responses: missing items are skipped, merged items give their new ID", () => {
    const json = { entities: { Q1: { id: "Q1", missing: "" }, Q2: { ...dostoyevsky, id: "Q3", redirects: { from: "Q2", to: "Q3" } } } };
    expect(responseEntities(json).map((e) => e.id)).toEqual(["Q3"]);
    expect(responseRedirects(json)).toEqual([["Q2", "Q3"]]);
  });
});

// ---------------------------------------------------------------- the format

describe("reference format", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "bookshelf-ref-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the spec's tables are exactly the schema's", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/reference-data-format.md"), "utf8");
    const ddl = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    const db = new Database(":memory:");
    db.exec(ddl);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const fromDoc = Object.fromEntries(tables.map((t) => [t, (db.query("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[]).map((c) => c.name)]));
    expect(fromDoc).toEqual(Object.fromEntries([...SCHEMA_COLUMNS].map(([t, cols]) => [t, [...cols]])));
  });

  test("a new file passes; incomplete, other formats, other versions and missing columns are refused", () => {
    const db = new Database(":memory:");
    createReferenceSchema(db, { source: "test" });
    expect(checkReferenceDb(db)).toEqual([]);
    expect(checkReferenceDb(db, { requireComplete: true })[0]).toContain("hasn't finished");
    completeReferenceDb(db);
    expect(checkReferenceDb(db, { requireComplete: true })).toEqual([]);
    expect(readMeta(db).built_at).toBeTruthy();

    db.exec("ALTER TABLE works DROP COLUMN prominence");
    expect(checkReferenceDb(db)).toEqual(["Table works has no column prominence"]);
    setMeta(db, { format_version: "2" });
    expect(checkReferenceDb(db)[0]).toContain("Unsupported format version 2");
    setMeta(db, { format: "other" });
    expect(checkReferenceDb(db)[0]).toContain("Not a Bookshelf reference file");
    expect(checkReferenceDb(new Database(":memory:"))[0]).toContain("no meta table");
    expect(() => createReferenceSchema(new Database(":memory:"), { source: "Bad Name" })).toThrow("Invalid source name");
  });

  test("raw responses are kept compressed and read back as they came", () => {
    const db = new Database(":memory:");
    createReferenceSchema(db, { source: "test" });
    const body = JSON.stringify({ entities: { Q991: dostoyevsky } });
    const id = storeRawResponse(db, { url: "https://example.org/x", status: 200, contentType: "application/json", body });
    const row = db.query("SELECT encoding, body FROM raw_responses WHERE id = ?").get(id) as { encoding: string; body: Uint8Array };
    expect(row.encoding).toBe("gzip");
    expect(row.body.byteLength).toBeLessThan(body.length);
    expect(rawBodyText(row)).toBe(body);
  });
});

// ---------------------------------------------------------------- the build's normalize pass (no network)

/** A build file with stored responses, as `run` leaves it. */
function buildFile(path: string): Database {
  const db = new Database(path, { create: true });
  createReferenceSchema(db, { source: "wikidata", languages: "en,ru" });
  db.exec(BUILD_SCHEMA);
  const respond = (role: string, entities: Record<string, unknown>) => {
    const id = storeRawResponse(db, { url: `https://www.wikidata.org/w/api.php?ids=${Object.keys(entities).join("|")}`, status: 200, body: JSON.stringify({ entities }) });
    db.query("INSERT INTO build_fetches (response_id, role) VALUES (?, ?)").run(id, role);
  };
  respond("work", { Q160534: crimeAndPunishment });
  // Q500 (the illustrator) was never fetched; Q600 was merged into Q601.
  respond("person", { Q991: dostoyevsky, Q600: { id: "Q601", labels: labels({ en: "Constance Garnett" }), redirects: { from: "Q600", to: "Q601" } } });
  respond("edition", { Q777: edition });
  respond("publisher", { Q1: { id: "Q1", labels: labels({ en: "Penguin Books" }) } });
  db.query("INSERT INTO build_redirects (from_id, to_id) VALUES ('Q600', 'Q601')").run();
  return db;
}

describe("Wikidata build: normalize", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "bookshelf-wd-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("rows are made from the stored responses; references follow merges, and credits of people never fetched go", () => {
    const db = buildFile(join(dir, "wd.sqlite"));
    normalize(db);
    expect(db.query("SELECT id, name FROM authors ORDER BY id").all()).toEqual([
      { id: "Q601", name: "Constance Garnett" },
      { id: "Q991", name: "Fyodor Dostoyevsky" },
    ]);
    expect(db.query("SELECT author_id, role FROM work_authors").all()).toEqual([{ author_id: "Q991", role: "author" }]);
    expect(db.query("SELECT author_id, role FROM edition_authors").all()).toEqual([{ author_id: "Q601", role: "translator" }]);
    // The series was never fetched: no dangling reference.
    expect(db.query("SELECT series_id, series_index FROM works").get()).toEqual({ series_id: null, series_index: null });
    expect(db.query("SELECT publisher, work_id FROM editions").get()).toEqual({ publisher: "Penguin Books", work_id: "Q160534" });
    // Only the languages the build kept.
    expect((db.query("SELECT DISTINCT lang FROM work_titles ORDER BY lang").all() as { lang: string }[]).map((r) => r.lang)).toEqual(["en", "ru"]);

    // Running it again gives the same rows, not twice as many.
    const before = db.query("SELECT COUNT(*) AS n FROM author_names").get();
    normalize(db);
    expect(db.query("SELECT COUNT(*) AS n FROM author_names").get()).toEqual(before);
    db.close();
  });
});

// ---------------------------------------------------------------- importing into Bookshelf

/** A finished reference file on disk. */
function referenceFile(path: string, source = "wikidata", complete = true): string {
  const db = buildFile(path);
  normalize(db);
  setMeta(db, { source, source_name: source === "wikidata" ? "Wikidata" : source, source_version: "2026-11-20" });
  if (complete) completeReferenceDb(db);
  db.close();
  return path;
}

describe("reference store", () => {
  let dir: string;
  let refDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bookshelf-refstore-"));
    refDir = join(dir, "data/reference");
    mkdirSync(refDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a file on the server is copied in under its source's name and listed with its counts; the original stays", async () => {
    const original = referenceFile(join(dir, "built.sqlite"));
    const s = await referenceStore.importFile(refDir, original);
    expect(s).toMatchObject({ source: "wikidata", name: "Wikidata", version: "2026-11-20", languages: "en,ru", license: null });
    expect(s.counts).toEqual({ authors: 2, works: 1, series: 0, editions: 1 });
    expect(referenceStore.list(refDir).map((x) => x.source)).toEqual(["wikidata"]);
    expect(referenceStore.pathOf(refDir, "wikidata")).toBe(join(dir, "data/reference/wikidata.sqlite"));
    expect(readFileSync(original).byteLength).toBeGreaterThan(0);
  });

  test("a newer file of the same source replaces the old one; other sources sit next to it", async () => {
    await referenceStore.importFile(refDir, referenceFile(join(dir, "a.sqlite")));
    const newer = referenceFile(join(dir, "b.sqlite"));
    const db = new Database(newer);
    setMeta(db, { source_version: "2026-12-01" });
    db.close();
    await referenceStore.importFile(refDir, newer);
    await referenceStore.importFile(refDir, referenceFile(join(dir, "c.sqlite"), "openlibrary"));
    expect(referenceStore.list(refDir).map((s) => `${s.source} ${s.version}`)).toEqual(["openlibrary 2026-11-20", "wikidata 2026-12-01"]);
    referenceStore.remove(refDir, "openlibrary");
    expect(referenceStore.list(refDir).map((s) => s.source)).toEqual(["wikidata"]);
    expect(() => referenceStore.remove(refDir, "openlibrary")).toThrow("No reference data from openlibrary");
  });

  test("unfinished builds and files that aren't reference files are refused, and nothing is left behind", async () => {
    await expect(referenceStore.importFile(refDir, referenceFile(join(dir, "partial.sqlite"), "wikidata", false))).rejects.toThrow("hasn't finished");
    writeFileSync(join(dir, "notes.sqlite"), "just text, not a database at all".repeat(50));
    await expect(referenceStore.importFile(refDir, join(dir, "notes.sqlite"))).rejects.toThrow("Not a SQLite database");
    const other = new Database(join(dir, "other.sqlite"));
    other.exec("CREATE TABLE t (x)");
    other.close();
    await expect(referenceStore.importFile(refDir, join(dir, "other.sqlite"))).rejects.toThrow("no meta table");
    await expect(referenceStore.importFile(refDir, join(dir, "nope.sqlite"))).rejects.toThrow("No such file");
    expect(referenceStore.list(refDir)).toEqual([]);
    expect(readdirSync(refDir)).toEqual([]);
  });
});

describe("reference API", () => {
  let dir: string;
  let app: AppContext;
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bookshelf-refapi-"));
    app = createApp(loadConfig({ data_dir: join(dir, "data"), max_upload_mb: 1 }));
    server = Bun.serve({ port: 0, routes: apiRoutes(app) });
  });
  afterEach(async () => {
    server.stop(true);
    await app.library.close();
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("upload, list, import from a server path, remove", async () => {
    const file = referenceFile(join(dir, "wd.sqlite"));
    const up = await fetch(`${server.url}api/reference?name=wd.sqlite`, { method: "POST", body: Bun.file(file) });
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({ source: "wikidata", counts: { authors: 2 } });

    const ol = referenceFile(join(dir, "ol.sqlite"), "openlibrary");
    const fromPath = await fetch(`${server.url}api/reference/from-file`, { method: "POST", body: JSON.stringify({ path: ol }) });
    expect(fromPath.status).toBe(201);

    const list = (await (await fetch(`${server.url}api/reference`)).json()) as { source: string }[];
    expect(list.map((s) => s.source)).toEqual(["openlibrary", "wikidata"]);

    expect((await fetch(`${server.url}api/reference/openlibrary`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${server.url}api/reference/openlibrary`, { method: "DELETE" })).status).toBe(404);
  });

  test("errors say why: an unfinished build, a file over the upload limit", async () => {
    const partial = referenceFile(join(dir, "p.sqlite"), "wikidata", false);
    const res = await fetch(`${server.url}api/reference?name=p.sqlite`, { method: "POST", body: Bun.file(partial) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("hasn't finished");

    const big = new Uint8Array(2 * 1024 * 1024);
    const tooBig = await fetch(`${server.url}api/reference?name=big.sqlite`, { method: "POST", body: big });
    expect(tooBig.status).toBe(400);
    expect(((await tooBig.json()) as { error: string }).error).toContain("import it from a path on the server");
  });
});

describe("Wikidata build: retries and rows", () => {
  test("answers: success, temporary problems worth retrying, and the rest", () => {
    expect(classifyAnswer(200, "{}", null)).toMatchObject({ kind: "ok", body: "{}" });
    expect(classifyAnswer(200, '{"error":{"code":"maxlag","info":"…"}}', "5")).toEqual({ kind: "retry", problem: "servers busy (maxlag)", retryAfterS: 5 });
    expect(classifyAnswer(429, "", null)).toEqual({ kind: "retry", problem: "HTTP 429", retryAfterS: null });
    expect(classifyAnswer(503, "", "30")).toEqual({ kind: "retry", problem: "HTTP 503", retryAfterS: 30 });
    expect(classifyAnswer(404, "", null)).toBeNull();
    expect([1, 2, 8, 9].map((a) => retryWaitSeconds(null, a))).toEqual([2, 4, 256, 300]);
    expect(retryWaitSeconds(7, 9)).toBe(7);
  });

  test("rows of several entities are concatenated per table, in order", () => {
    const a = { authors: [{ id: "Q1" }], works: [{ id: "Q10" }] } as never;
    const b = { authors: [{ id: "Q2" }], series: [{ id: "Q20" }] } as never;
    expect(mergeEntityRows([a, b])).toEqual({ authors: [{ id: "Q1" }, { id: "Q2" }], works: [{ id: "Q10" }], series: [{ id: "Q20" }] } as never);
  });
});
