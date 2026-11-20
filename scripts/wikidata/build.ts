#!/usr/bin/env bun
/**
 * Builds a Bookshelf reference file (docs/reference-data-format.md) from Wikidata.
 *
 *   bun scripts/wikidata/build.ts run <file.sqlite> [options]   start, or resume where it stopped
 *   bun scripts/wikidata/build.ts status <file.sqlite>          how far it got
 *   bun scripts/wikidata/build.ts normalize <file.sqlite>       rebuild the rows from the stored responses (no network)
 *
 * `run` options:
 *   --langs en,es,ru     languages kept for names and titles (default: all). Fixed when the file is created.
 *   --contact <text>     how Wikimedia can reach you (an email or a URL), added to the User-Agent as their policy asks
 *   --max-requests <n>   stop after n requests (to try it out); run again to go on
 *   --page-size <n>      items per discovery query (default 10000)
 *   --batch <n>          items per wbgetentities call (default and maximum 50)
 * `normalize` option:
 *   --partial            mark the file complete even though fetching hasn't finished, to try it in Bookshelf
 *                        (`run` sets it back to building and goes on)
 *
 * The build: discovery queries (SPARQL) list people, works and editions; each item is fetched with
 * wbgetentities, which also queues what it refers to (a work's authors, series and editions, an edition's
 * publisher…); when nothing is left, the rows are made from the stored responses and the file is marked
 * complete. Every response is kept (gzip) with what it led to in one transaction, so the build can be stopped
 * at any moment (Ctrl+C) and resumed.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  checkReferenceDb,
  completeReferenceDb,
  countRows,
  createReferenceSchema,
  DATA_TABLES,
  rawBodyText,
  readMeta,
  setMeta,
  storeRawResponse,
} from "../../src/server/reference/format.ts";
import {
  entityRows,
  pickText,
  references,
  responseEntities,
  responseRedirects,
  ROLES,
  SEEDS,
  seedQuery,
  sparqlItems,
  type Languages,
  type Role,
  type Row,
  type Rows,
} from "./wikidata.ts";

const API = "https://www.wikidata.org/w/api.php";
const SPARQL = "https://query.wikidata.org/sparql";
const BUILDER = "bookshelf-wikidata-build/1";
/** Minimum time between request starts, per host (serial requests; the query service allows 60 s of query time a minute). */
const PACE_MS: Record<string, number> = { "www.wikidata.org": 200, "query.wikidata.org": 1000 };
const MAX_ATTEMPTS = 8;

export const BUILD_SCHEMA = `
CREATE TABLE IF NOT EXISTS build_seeds (name TEXT PRIMARY KEY, next_offset INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS build_queue (
  id          TEXT NOT NULL,
  role        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'missing'
  response_id INTEGER,
  PRIMARY KEY (id, role)
);
CREATE INDEX IF NOT EXISTS build_queue_pending ON build_queue (role) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS build_fetches (response_id INTEGER PRIMARY KEY, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS build_redirects (from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
`;

// ---------------------------------------------------------------- CLI

const USAGE = "usage: bun scripts/wikidata/build.ts run|status|normalize <file.sqlite> [options] (see the top of this file)";

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      langs: { type: "string" },
      contact: { type: "string" },
      "max-requests": { type: "string" },
      "page-size": { type: "string" },
      batch: { type: "string" },
      partial: { type: "boolean" },
    },
  });
  const [command, file] = positionals;
  if (!command || !file || !["run", "status", "normalize"].includes(command)) {
    console.error(USAGE);
    return 2;
  }
  if (command !== "run" && !existsSync(file)) {
    console.error(`No such file: ${file}`);
    return 1;
  }
  const db = openBuild(file, command === "run" ? parseLangs(values.langs) : undefined);
  try {
    if (command === "status") return printStatus(db, file);
    if (command === "normalize") return normalizeCommand(db, !!values.partial);
    return await run(db, {
      contact: values.contact ?? null,
      maxRequests: positiveInt(values["max-requests"], Infinity),
      pageSize: positiveInt(values["page-size"], 10_000),
      batch: Math.min(50, positiveInt(values.batch, 50)),
    });
  } finally {
    db.close();
  }
}

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Expected a positive whole number, got "${v}"`);
  return n;
}

/** `--langs en,es` → 'en,es'; none → '*' (every language). */
const parseLangs = (v: string | undefined): string =>
  v
    ? v
        .split(",")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean)
        .join(",") || "*"
    : "*";

const langSet = (meta: Record<string, string>): Languages => (!meta.languages || meta.languages === "*" ? null : new Set(meta.languages.split(",")));

// ---------------------------------------------------------------- the file

/** Open (or create) a build file; `langs` is given by `run`, and must match what the file was created with. */
function openBuild(file: string, langs: string | undefined): Database {
  const isNew = !existsSync(file);
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  if (isNew) {
    createReferenceSchema(db, {
      source: "wikidata",
      source_name: "Wikidata",
      source_url: "https://www.wikidata.org/",
      source_version: new Date().toISOString().slice(0, 10),
      languages: langs ?? "*",
      license: "CC0-1.0",
      builder: BUILDER,
    });
  }
  const problems = checkReferenceDb(db);
  const meta = readMeta(db);
  if (problems.length || meta.source !== "wikidata") {
    db.close();
    throw new Error(`${file} is not a Wikidata reference build: ${problems[0] ?? `its source is "${meta.source}"`}`);
  }
  if (langs !== undefined && langs !== "*" && langs !== meta.languages) {
    db.close();
    throw new Error(`${file} was started with --langs ${meta.languages}; resume it with the same languages, or start a new file`);
  }
  db.exec(BUILD_SCHEMA);
  return db;
}

// ---------------------------------------------------------------- HTTP

class StopRequested extends Error {}

interface Fetcher {
  get(url: string, accept: string): Promise<{ status: number; contentType: string | null; body: string }>;
  readonly count: number;
}

/**
 * Serial GETs at each host's pace, with a User-Agent naming the tool (and you, with --contact). Retries what
 * is worth retrying (429, 5xx, network errors, Wikidata's "maxlag": the servers are busy), waiting as asked.
 */
function makeFetcher(contact: string | null, maxRequests: number, stopped: () => boolean): Fetcher {
  const userAgent = `BookshelfReferenceBuilder/1.0 (Wikidata reference build for a self-hosted book manager${contact ? `; ${contact}` : ""})`;
  const last = new Map<string, number>();
  let count = 0;

  const pace = async (host: string) => {
    const wait = (last.get(host) ?? 0) + (PACE_MS[host] ?? 1000) - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    last.set(host, Date.now());
  };

  return {
    get count() {
      return count;
    },
    async get(url, accept) {
      const host = new URL(url).host;
      for (let attempt = 1; ; attempt++) {
        if (stopped()) throw new StopRequested();
        if (count >= maxRequests) throw new StopRequested();
        await pace(host);
        count++;
        let retryAfter: number | null = null;
        let problem: string;
        try {
          const res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: accept, "Accept-Encoding": "gzip" } });
          const body = await res.text();
          const maxlag = res.ok && body.startsWith('{"error":{"code":"maxlag"');
          if (res.ok && !maxlag) return { status: res.status, contentType: res.headers.get("content-type"), body };
          if (res.status !== 429 && res.status < 500 && !maxlag) throw new Error(`${res.status} from ${host}: ${body.slice(0, 300)}`);
          retryAfter = Number(res.headers.get("retry-after")) || null;
          problem = maxlag ? "servers busy (maxlag)" : `HTTP ${res.status}`;
        } catch (err) {
          if (err instanceof Error && /^\d{3} from /.test(err.message)) throw err;
          problem = `network error: ${(err as Error).message}`;
        }
        if (attempt >= MAX_ATTEMPTS) throw new Error(`${host} kept failing (${problem}); run again later to resume`);
        const waitS = retryAfter ?? Math.min(300, 2 ** attempt);
        console.log(`  ${problem}; waiting ${waitS} s (attempt ${attempt} of ${MAX_ATTEMPTS})`);
        await Bun.sleep(waitS * 1000);
      }
    },
  };
}

// ---------------------------------------------------------------- run

interface RunOptions {
  contact: string | null;
  maxRequests: number;
  pageSize: number;
  batch: number;
}

async function run(db: Database, opts: RunOptions): Promise<number> {
  if (readMeta(db).status === "complete" && isFinished(db)) {
    console.log("This build is complete. To update the data, build a new file and import it into Bookshelf.");
    return 0;
  }
  setMeta(db, { status: "building", built_at: null });
  db.exec("PRAGMA journal_mode = WAL");
  if (!opts.contact) console.log("Note: Wikimedia asks automated clients for a way to contact them; pass --contact <email or URL>.");

  let stop = false;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    console.log("\nStopping after the current request (Ctrl+C again to quit at once; the last step would be redone)…");
  };
  process.on("SIGINT", onSigint);
  const http = makeFetcher(opts.contact, opts.maxRequests, () => stop);

  try {
    for (;;) {
      const role = nextPendingRole(db);
      if (role) await fetchBatch(db, http, role, opts.batch);
      else {
        const seed = SEEDS.find((s) => !seedDone(db, s.name));
        if (!seed) break;
        await discover(db, http, seed, opts.pageSize);
      }
    }
  } catch (err) {
    if (!(err instanceof StopRequested)) throw err;
    console.log(`Stopped after ${http.count} requests. Run the same command again to go on.`);
    printProgress(db);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
  }

  console.log("Everything fetched; making the rows…");
  normalize(db);
  completeReferenceDb(db);
  console.log("Complete. Import the file in Bookshelf: POST /api/reference/from-file {\"path\": …} or POST /api/reference.");
  printProgress(db);
  return 0;
}

const isFinished = (db: Database): boolean => nextPendingRole(db) === null && SEEDS.every((s) => seedDone(db, s.name));

const seedDone = (db: Database, name: string): boolean =>
  (db.query("SELECT done FROM build_seeds WHERE name = ?").get(name) as { done: number } | null)?.done === 1;

function nextPendingRole(db: Database): Role | null {
  const row = db.query("SELECT role FROM build_queue WHERE state = 'pending' LIMIT 1").get() as { role: Role } | null;
  return row?.role ?? null;
}

async function discover(db: Database, http: Fetcher, seed: (typeof SEEDS)[number], pageSize: number): Promise<void> {
  const offset = (db.query("SELECT next_offset FROM build_seeds WHERE name = ?").get(seed.name) as { next_offset: number } | null)?.next_offset ?? 0;
  const url = `${SPARQL}?${new URLSearchParams({ query: seedQuery(seed, pageSize, offset), format: "json" })}`;
  const res = await http.get(url, "application/sparql-results+json");
  const json = JSON.parse(res.body) as { results?: { bindings?: unknown[] } };
  const rows = json.results?.bindings?.length ?? 0;
  const items = sparqlItems(json);
  const done = rows < pageSize;
  db.transaction(() => {
    storeRawResponse(db, { url, status: res.status, contentType: res.contentType, body: res.body });
    const queue = db.query("INSERT OR IGNORE INTO build_queue (id, role) VALUES (?, ?)");
    items.forEach((id) => queue.run(id, seed.role));
    db.query(
      `INSERT INTO build_seeds (name, next_offset, done) VALUES (?1, ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET next_offset = ?2, done = ?3`,
    ).run(seed.name, offset + rows, done ? 1 : 0);
  })();
  console.log(`discover ${seed.name}: ${items.length} items at ${offset}${done ? " (last page)" : ""}`);
}

async function fetchBatch(db: Database, http: Fetcher, role: Role, batch: number): Promise<void> {
  const ids = (db.query("SELECT id FROM build_queue WHERE role = ? AND state = 'pending' LIMIT ?").all(role, batch) as { id: string }[]).map((r) => r.id);
  const langs = readMeta(db).languages;
  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels|aliases|descriptions|claims|sitelinks",
    format: "json",
    // No maxlag: it makes *editing* bots wait for the query service's update lag (often minutes); reads
    // add no replication load, and serial requests at this pace are within Wikimedia's API etiquette.
    ...(langs && langs !== "*" ? { languages: `${langs.replaceAll(",", "|")}|mul` } : {}),
  });
  const url = `${API}?${params}`;
  const res = await http.get(url, "application/json");
  const json = JSON.parse(res.body) as unknown;
  if ((json as { error?: { info?: string } }).error) throw new Error(`Wikidata refused the request: ${(json as { error: { info?: string } }).error.info}`);
  const entities = responseEntities(json);
  const redirects = responseRedirects(json);
  const answered = new Set([...entities.map((e) => e.id), ...redirects.map(([from]) => from)]);
  const refs = entities.flatMap((e) => references(e, role));

  db.transaction(() => {
    const responseId = storeRawResponse(db, { url, status: res.status, contentType: res.contentType, body: res.body });
    db.query("INSERT INTO build_fetches (response_id, role) VALUES (?, ?)").run(responseId, role);
    const mark = db.query("UPDATE build_queue SET state = ?, response_id = ? WHERE id = ? AND role = ?");
    ids.forEach((id) => mark.run(answered.has(id) ? "done" : "missing", answered.has(id) ? responseId : null, id, role));
    // A merged item answers under its new ID: that one counts as fetched too.
    const done = db.query("INSERT INTO build_queue (id, role, state, response_id) VALUES (?, ?, 'done', ?) ON CONFLICT DO UPDATE SET state = 'done', response_id = excluded.response_id");
    entities.filter((e) => !ids.includes(e.id)).forEach((e) => done.run(e.id, role, responseId));
    const redirect = db.query("INSERT OR REPLACE INTO build_redirects (from_id, to_id) VALUES (?, ?)");
    redirects.forEach(([from, to]) => redirect.run(from, to));
    const queue = db.query("INSERT OR IGNORE INTO build_queue (id, role) VALUES (?, ?)");
    refs.forEach((r) => queue.run(r.id, r.role));
  })();
  const pending = (db.query("SELECT COUNT(*) AS n FROM build_queue WHERE state = 'pending'").get() as { n: number }).n;
  console.log(`fetch ${role}: ${entities.length} of ${ids.length} items, ${refs.length} references · ${pending.toLocaleString("en")} waiting`);
}

// ---------------------------------------------------------------- normalize

const KEYED_TABLES = new Set(["authors", "works", "series", "editions"]);

/** Insert rows; for the main tables a later response replaces an earlier one, elsewhere duplicates are skipped. */
function insertRows(db: Database, rows: Rows, statements: Map<string, ReturnType<Database["query"]>>): void {
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list ?? []) {
      const cols = Object.keys(row);
      const key = `${table}(${cols.join(",")})`;
      const stmt =
        statements.get(key) ??
        db.query(`INSERT OR ${KEYED_TABLES.has(table) ? "REPLACE" : "IGNORE"} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      statements.set(key, stmt);
      stmt.run(...cols.map((c) => (row as Row)[c]!));
    }
  }
}

interface StoredResponse {
  id: number;
  encoding: string;
  body: Uint8Array;
  role: Role;
}

/** Stored entity responses in order, a page at a time (each page is handled in one transaction). */
function* responsePages(db: Database, roles: readonly Role[], pageSize = 200): Generator<StoredResponse[]> {
  const q = db.query(
    `SELECT r.id, r.encoding, r.body, f.role FROM raw_responses r JOIN build_fetches f ON f.response_id = r.id
     WHERE r.id > ? AND f.role IN (${roles.map(() => "?").join(", ")}) ORDER BY r.id LIMIT ?`,
  );
  for (let after = 0; ; ) {
    const page = q.all(after, ...roles, pageSize) as StoredResponse[];
    if (!page.length) return;
    yield page;
    after = page.at(-1)!.id;
  }
}

/** Rebuild every row from the stored responses (the raw responses and the build tables stay as they are). */
export function normalize(db: Database): void {
  const langs = langSet(readMeta(db));
  db.transaction(() => DATA_TABLES.forEach((t) => db.exec(`DELETE FROM ${t}`)))();

  const publishers = new Map<string, string>();
  for (const page of responsePages(db, ["publisher"])) {
    for (const r of page) for (const e of responseEntities(JSON.parse(rawBodyText(r)))) publishers.set(e.id, pickText(e.labels) ?? "");
  }
  const publisherName = (id: string) => publishers.get(id) || null;

  const statements = new Map<string, ReturnType<Database["query"]>>();
  let entities = 0;
  for (const page of responsePages(db, ROLES.filter((r) => r !== "publisher"))) {
    db.transaction(() => {
      for (const r of page) {
        for (const e of responseEntities(JSON.parse(rawBodyText(r)))) {
          insertRows(db, entityRows(e, r.role, langs, publisherName, r.id), statements);
          entities++;
        }
      }
    })();
  }

  // Point references at merged items' new IDs, then drop what points at nothing fetched.
  db.transaction(() =>
    db.exec(`
      UPDATE OR IGNORE work_authors SET author_id = (SELECT to_id FROM build_redirects WHERE from_id = author_id)
        WHERE author_id IN (SELECT from_id FROM build_redirects);
      UPDATE OR IGNORE edition_authors SET author_id = (SELECT to_id FROM build_redirects WHERE from_id = author_id)
        WHERE author_id IN (SELECT from_id FROM build_redirects);
      UPDATE editions SET work_id = (SELECT to_id FROM build_redirects WHERE from_id = work_id) WHERE work_id IN (SELECT from_id FROM build_redirects);
      UPDATE works SET series_id = (SELECT to_id FROM build_redirects WHERE from_id = series_id) WHERE series_id IN (SELECT from_id FROM build_redirects);
      DELETE FROM work_authors WHERE author_id NOT IN (SELECT id FROM authors);
      DELETE FROM edition_authors WHERE author_id NOT IN (SELECT id FROM authors);
      UPDATE editions SET work_id = NULL WHERE work_id IS NOT NULL AND work_id NOT IN (SELECT id FROM works);
      UPDATE works SET series_id = NULL, series_index = NULL WHERE series_id IS NOT NULL AND series_id NOT IN (SELECT id FROM series);
    `),
  )();
  console.log(`Made rows from ${entities.toLocaleString("en")} entities.`);
}

function normalizeCommand(db: Database, partial: boolean): number {
  normalize(db);
  if (isFinished(db) || partial) {
    completeReferenceDb(db);
    console.log(isFinished(db) ? "Complete." : "Marked complete although fetching hasn't finished (--partial); `run` goes on from where it stopped.");
  } else {
    console.log("Fetching hasn't finished, so the file stays \"building\" (pass --partial to mark it complete anyway).");
  }
  printProgress(db);
  return 0;
}

// ---------------------------------------------------------------- status

function printProgress(db: Database): void {
  const meta = readMeta(db);
  const seeds = new Map((db.query("SELECT name, next_offset, done FROM build_seeds").all() as { name: string; next_offset: number; done: number }[]).map((s) => [s.name, s]));
  const queue = db.query("SELECT role, state, COUNT(*) AS n FROM build_queue GROUP BY role, state").all() as { role: string; state: string; n: number }[];
  const n = (role: string, state: string) => (queue.find((q) => q.role === role && q.state === state)?.n ?? 0).toLocaleString("en");
  console.log(`status: ${meta.status} · languages: ${meta.languages} · started ${meta.source_version}`);
  console.log("discovery:");
  for (const s of SEEDS) {
    const row = seeds.get(s.name);
    console.log(`  ${s.name.padEnd(20)} ${row?.done ? "done" : "to do"}, ${(row?.next_offset ?? 0).toLocaleString("en")} rows read`);
  }
  console.log("items (fetched · waiting · missing):");
  for (const r of ROLES) console.log(`  ${r.padEnd(10)} ${n(r, "done")} · ${n(r, "pending")} · ${n(r, "missing")}`);
  const c = countRows(db);
  console.log(`rows: ${c.authors} authors, ${c.works} works, ${c.series} series, ${c.editions} editions · ${c.rawResponses} responses kept`);
}

function printStatus(db: Database, file: string): number {
  printProgress(db);
  const size = ["", "-wal"].reduce((sum, ext) => sum + (existsSync(file + ext) ? statSync(file + ext).size : 0), 0);
  console.log(`file: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
