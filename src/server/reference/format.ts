/**
 * The reference file format ("bookshelf-reference", version 1): one SQLite file of authors, works, series
 * and editions per source, with the raw responses they were made from. Specified in
 * docs/reference-data-format.md; shared by Bookshelf and the builder scripts (scripts/wikidata/…).
 */
import { Database } from "bun:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

export const FORMAT = "bookshelf-reference";
export const FORMAT_VERSION = 1;

/** Version 1's tables, exactly as in the spec. */
export const SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE authors (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_name   TEXT,
  description TEXT,
  birth_year  INTEGER,
  death_year  INTEGER,
  prominence  INTEGER
);
CREATE TABLE author_names (
  author_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL,
  PRIMARY KEY (author_id, name, lang, kind)
);

CREATE TABLE works (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  first_year    INTEGER,
  original_lang TEXT,
  series_id     TEXT,
  series_index  REAL,
  prominence    INTEGER
);
CREATE TABLE work_titles (
  work_id TEXT NOT NULL,
  title   TEXT NOT NULL,
  lang    TEXT NOT NULL DEFAULT '',
  kind    TEXT NOT NULL,
  PRIMARY KEY (work_id, title, lang, kind)
);
CREATE TABLE work_authors (
  work_id   TEXT NOT NULL,
  author_id TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'author',
  position  INTEGER NOT NULL,
  PRIMARY KEY (work_id, author_id, role)
);

CREATE TABLE series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT
);
CREATE TABLE series_names (
  series_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL,
  PRIMARY KEY (series_id, name, lang, kind)
);

CREATE TABLE editions (
  id             TEXT PRIMARY KEY,
  work_id        TEXT,
  title          TEXT,
  subtitle       TEXT,
  publisher      TEXT,
  published_date TEXT,
  year           INTEGER,
  lang           TEXT,
  pages          INTEGER,
  binding        TEXT,
  description    TEXT
);
CREATE TABLE edition_authors (
  edition_id TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'author',
  position   INTEGER NOT NULL,
  PRIMARY KEY (edition_id, author_id, role)
);

CREATE TABLE identifiers (
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scheme    TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, scheme, value)
);
CREATE INDEX identifiers_value ON identifiers (scheme, value);

CREATE TABLE raw_responses (
  id           INTEGER PRIMARY KEY,
  url          TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT 'GET',
  request_body TEXT,
  status       INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL,
  content_type TEXT,
  encoding     TEXT NOT NULL,
  body         BLOB NOT NULL
);
CREATE TABLE record_sources (
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  response_id INTEGER NOT NULL,
  PRIMARY KEY (entity, entity_id, response_id)
);
`;

/** The tables holding normalized rows (everything but `meta`, the raw responses and builders' own tables). */
export const DATA_TABLES = [
  "authors",
  "author_names",
  "works",
  "work_titles",
  "work_authors",
  "series",
  "series_names",
  "editions",
  "edition_authors",
  "identifiers",
  "record_sources",
] as const;

export type EntityKind = "author" | "work" | "series" | "edition";
export type BuildStatus = "building" | "complete";

/** The `meta` keys a file must have. */
export const REQUIRED_META = ["format", "format_version", "source", "status"] as const;
export const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Each table of the schema with its columns, read from the schema itself. */
export const SCHEMA_COLUMNS: ReadonlyMap<string, readonly string[]> = (() => {
  const db = new Database(":memory:");
  try {
    db.exec(SCHEMA_SQL);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    return new Map(tables.map(({ name }) => [name, tableColumns(db, name)]));
  } finally {
    db.close();
  }
})();

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
}

/** Create the schema in an empty database and set its `meta` (`format`, `format_version` and `status` included). */
export function createReferenceSchema(db: Database, meta: { source: string } & Record<string, string>): void {
  if (!SOURCE_NAME.test(meta.source)) throw new Error(`Invalid source name: ${meta.source}`);
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    setMeta(db, { format: FORMAT, format_version: String(FORMAT_VERSION), status: "building", ...meta });
  })();
}

export function setMeta(db: Database, entries: Record<string, string | null>): void {
  const put = db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const del = db.query("DELETE FROM meta WHERE key = ?");
  db.transaction(() => Object.entries(entries).forEach(([k, v]) => (v === null ? del.run(k) : put.run(k, v))))();
}

export function readMeta(db: Database): Record<string, string> {
  const rows = db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Mark a build finished: `status = complete`, `built_at`, and a single-file journal so the file can be copied. */
export function completeReferenceDb(db: Database, builtAt = new Date()): void {
  setMeta(db, { status: "complete", built_at: builtAt.toISOString() });
  db.exec("PRAGMA journal_mode = DELETE");
}

/**
 * What keeps a database from being a usable reference file (empty when it is one): its `meta`, then every
 * table and column of the schema. `requireComplete` also refuses files whose build hasn't finished.
 */
export function checkReferenceDb(db: Database, opts: { requireComplete?: boolean } = {}): string[] {
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
  if (!tables.has("meta")) return ["Not a Bookshelf reference file: it has no meta table"];
  const meta = readMeta(db);
  if (meta.format !== FORMAT) return [`Not a Bookshelf reference file: format is ${meta.format ? `"${meta.format}"` : "missing"}`];
  if (meta.format_version !== String(FORMAT_VERSION)) {
    return [`Unsupported format version ${meta.format_version ?? "(missing)"}: this Bookshelf reads version ${FORMAT_VERSION}`];
  }
  const missingMeta = REQUIRED_META.filter((k) => !meta[k]).map((k) => `meta has no "${k}"`);
  const badSource = meta.source && !SOURCE_NAME.test(meta.source) ? [`Invalid source name "${meta.source}" (lowercase letters, digits and -)`] : [];
  const badStatus = meta.status && meta.status !== "building" && meta.status !== "complete" ? [`Unknown status "${meta.status}"`] : [];
  const unfinished = opts.requireComplete && meta.status === "building" ? ["The build hasn't finished (status is \"building\"): finish or resume it first"] : [];
  const schema = [...SCHEMA_COLUMNS].flatMap(([table, columns]) => {
    if (!tables.has(table)) return [`Missing table ${table}`];
    const have = new Set(tableColumns(db, table));
    return columns.filter((c) => !have.has(c)).map((c) => `Table ${table} has no column ${c}`);
  });
  return [...missingMeta, ...badSource, ...badStatus, ...unfinished, ...schema];
}

/** Row counts of the main tables, for display. */
export interface ReferenceCounts {
  authors: number;
  works: number;
  series: number;
  editions: number;
  rawResponses: number;
}

export function countRows(db: Database): ReferenceCounts {
  const n = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { authors: n("authors"), works: n("works"), series: n("series"), editions: n("editions"), rawResponses: n("raw_responses") };
}

export interface RawResponseInput {
  url: string;
  method?: string;
  requestBody?: string | null;
  status: number;
  fetchedAt?: Date;
  contentType?: string | null;
  body: string | Uint8Array;
}

/** Store a response gzip-compressed; returns its id. */
export function storeRawResponse(db: Database, r: RawResponseInput): number {
  const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
  const row = db
    .query(
      `INSERT INTO raw_responses (url, method, request_body, status, fetched_at, content_type, encoding, body)
       VALUES (?, ?, ?, ?, ?, ?, 'gzip', ?) RETURNING id`,
    )
    .get(r.url, r.method ?? "GET", r.requestBody ?? null, r.status, (r.fetchedAt ?? new Date()).toISOString(), r.contentType ?? null, gzipSync(bytes)) as {
    id: number;
  };
  return row.id;
}

/** A stored response's body as text, whatever its encoding. */
export function rawBodyText(row: { encoding: string; body: Uint8Array }): string {
  const bytes = row.encoding === "gzip" ? gunzipSync(row.body) : row.body;
  return new TextDecoder().decode(bytes);
}
