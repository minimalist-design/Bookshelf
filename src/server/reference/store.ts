/**
 * The imported reference files (docs/reference-data-format.md): one per source, at
 * `<data dir>/reference/<source>.sqlite`, apart from the library database. Importing checks the file and
 * then swaps it in whole, so a newer build of a source replaces the old one in one step.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ReferenceSourceDto } from "../../shared/types.ts";
import { NotFoundError } from "../api/http.ts";
import { ValidationError } from "../library/paths.ts";
import { checkReferenceDb, countRows, readMeta, SOURCE_NAME, type ReferenceCounts } from "./format.ts";

const INCOMING_PREFIX = ".incoming-";

/* Every function takes the reference directory (`<data dir>/reference`) first. */

/** Remove the staged files of imports interrupted by a restart. */
export function cleanIncoming(dir: string): void {
  for (const f of readdirSync(dir)) if (f.startsWith(INCOMING_PREFIX)) rmSync(join(dir, f), { force: true });
}

/** The imported files, by source name. */
export function list(dir: string): ReferenceSourceDto[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite") && !f.startsWith("."))
    .map((f) => describe(join(dir, f), f.slice(0, -".sqlite".length)))
    .toSorted((a, b) => a.source.localeCompare(b.source));
}

/** The file of an imported source, or null. */
export function pathOf(dir: string, source: string): string | null {
  const path = join(dir, `${source}.sqlite`);
  return SOURCE_NAME.test(source) && isFile(path) ? path : null;
}

/** Import an uploaded file (the request body, streamed to disk, at most `maxBytes`). */
export async function importUpload(
  dir: string,
  body: ReadableStream<Uint8Array> | null,
  fileName: string,
  maxBytes: number,
): Promise<ReferenceSourceDto> {
  if (!body) throw new ValidationError("Empty upload");
  const tmp = incoming(dir);
  try {
    const size = await writeLimited(body, tmp, maxBytes);
    if (size === 0) throw new ValidationError("The file is empty");
    return install(dir, tmp, basename(fileName) || "upload");
  } finally {
    removeDb(tmp);
  }
}

/** Import a file already on the server (copied: the original stays where it is). */
export async function importFile(dir: string, path: string): Promise<ReferenceSourceDto> {
  const abs = resolve(path.trim());
  if (!path.trim() || !isFile(abs)) throw new ValidationError(`No such file: ${path}`);
  const tmp = incoming(dir);
  try {
    await copyFile(abs, tmp);
    return install(dir, tmp, abs);
  } finally {
    removeDb(tmp);
  }
}

export function remove(dir: string, source: string): void {
  const path = pathOf(dir, source);
  if (!path) throw new NotFoundError(`No reference data from ${source}`);
  removeDb(path);
}

function incoming(dir: string): string {
  return join(dir, `${INCOMING_PREFIX}${randomUUID()}.sqlite`);
}

/** Check the staged file, note when and where it came from, and move it into place. */
function install(dir: string, tmp: string, from: string): ReferenceSourceDto {
  const source = checkAndStamp(tmp, from);
  const target = join(dir, `${source}.sqlite`);
  for (const ext of ["-wal", "-shm", "-journal"]) rmSync(target + ext, { force: true });
  renameSync(tmp, target);
  return describe(target, source);
}

/** Reject an incomplete or invalid file; otherwise record the import in it and return its source name. */
function checkAndStamp(tmp: string, from: string): string {
  const db = openOrReject(tmp);
  try {
    const problems = checkReferenceDb(db, { requireComplete: true });
    if (problems.length) throw new ValidationError(problems.slice(0, 5).join("; "));
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS bookshelf_info (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const put = db.query("INSERT OR REPLACE INTO bookshelf_info (key, value) VALUES (?, ?)");
    put.run("imported_at", new Date().toISOString());
    put.run("imported_from", from);
    put.run("counts", JSON.stringify(countRows(db)));
    return readMeta(db).source!;
  } finally {
    db.close();
  }
}

function openOrReject(path: string): Database {
  try {
    const db = new Database(path);
    db.query("SELECT COUNT(*) FROM sqlite_master").get();
    return db;
  } catch {
    throw new ValidationError("Not a SQLite database");
  }
}

/** What Settings shows about an imported file (counts as noted at import, so listing stays quick on big files). */
function describe(path: string, fileSource: string): ReferenceSourceDto {
  const db = new Database(path, { readonly: true });
  try {
    const meta = readMeta(db);
    const hasInfo = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookshelf_info'").get() !== null;
    const rows = hasInfo ? (db.query("SELECT key, value FROM bookshelf_info").all() as { key: string; value: string }[]) : [];
    const info = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const counts = info.counts ? (JSON.parse(info.counts) as ReferenceCounts) : countRows(db);
    return {
      source: meta.source ?? fileSource,
      name: meta.source_name ?? meta.source ?? fileSource,
      url: meta.source_url ?? null,
      version: meta.source_version ?? null,
      builtAt: meta.built_at ?? null,
      importedAt: info.imported_at ?? null,
      languages: meta.languages ?? null,
      license: meta.license ?? null,
      counts: { authors: counts.authors, works: counts.works, series: counts.series, editions: counts.editions },
      bytes: statSync(path).size,
    };
  } finally {
    db.close();
  }
}

async function writeLimited(body: ReadableStream<Uint8Array>, path: string, maxBytes: number): Promise<number> {
  const sink = Bun.file(path).writer({ highWaterMark: 1024 * 1024 });
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ValidationError(`File exceeds the upload limit of ${Math.round(maxBytes / 1024 / 1024)} MB: import it from a path on the server instead`);
      sink.write(chunk);
    }
  } finally {
    await sink.end();
  }
  return size;
}

function removeDb(path: string): void {
  for (const ext of ["", "-wal", "-shm", "-journal"]) rmSync(path + ext, { force: true });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
