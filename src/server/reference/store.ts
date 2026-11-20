/**
 * The imported reference files (docs/reference-data-format.md): one per source, at
 * `<data dir>/reference/<source>.sqlite`, apart from the library database. Importing checks the file and
 * then swaps it in whole, so a newer build of a source replaces the old one in one step.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ReferenceSourceDto } from "../../shared/types.ts";
import { NotFoundError } from "../api/http.ts";
import { ValidationError } from "../library/paths.ts";
import { checkReferenceDb, countRows, readMeta, SOURCE_NAME, type ReferenceCounts } from "./format.ts";

const INCOMING_PREFIX = ".incoming-";

export class ReferenceStore {
  readonly dir: string;

  constructor(
    dataDir: string,
    private readonly maxUploadBytes: number,
  ) {
    this.dir = join(dataDir, "reference");
    mkdirSync(this.dir, { recursive: true });
    // Imports interrupted by a restart.
    for (const f of readdirSync(this.dir)) if (f.startsWith(INCOMING_PREFIX)) rmSync(join(this.dir, f), { force: true });
  }

  /** The imported files, by source name. */
  list(): ReferenceSourceDto[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".sqlite") && !f.startsWith("."))
      .map((f) => describe(join(this.dir, f), f.slice(0, -".sqlite".length)))
      .sort((a, b) => a.source.localeCompare(b.source));
  }

  /** The file of an imported source, or null. */
  pathOf(source: string): string | null {
    const path = join(this.dir, `${source}.sqlite`);
    return SOURCE_NAME.test(source) && isFile(path) ? path : null;
  }

  /** Import an uploaded file (the request body, streamed to disk). */
  async importUpload(body: ReadableStream<Uint8Array> | null, fileName: string): Promise<ReferenceSourceDto> {
    if (!body) throw new ValidationError("Empty upload");
    const tmp = this.incoming();
    try {
      const size = await writeLimited(body, tmp, this.maxUploadBytes);
      if (size === 0) throw new ValidationError("The file is empty");
      return this.install(tmp, basename(fileName) || "upload");
    } finally {
      removeDb(tmp);
    }
  }

  /** Import a file already on the server (copied: the original stays where it is). */
  async importFile(path: string): Promise<ReferenceSourceDto> {
    const abs = resolve(path.trim());
    if (!path.trim() || !isFile(abs)) throw new ValidationError(`No such file: ${path}`);
    const tmp = this.incoming();
    try {
      await copyFile(abs, tmp);
      return this.install(tmp, abs);
    } finally {
      removeDb(tmp);
    }
  }

  remove(source: string): void {
    const path = this.pathOf(source);
    if (!path) throw new NotFoundError(`No reference data from ${source}`);
    removeDb(path);
  }

  private incoming(): string {
    return join(this.dir, `${INCOMING_PREFIX}${randomUUID()}.sqlite`);
  }

  /** Check the staged file, note when and where it came from, and move it into place. */
  private install(tmp: string, from: string): ReferenceSourceDto {
    const db = openOrReject(tmp);
    let source: string;
    try {
      const problems = checkReferenceDb(db, { requireComplete: true });
      if (problems.length) throw new ValidationError(problems.slice(0, 5).join("; "));
      source = readMeta(db).source!;
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("CREATE TABLE IF NOT EXISTS bookshelf_info (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const put = db.query("INSERT OR REPLACE INTO bookshelf_info (key, value) VALUES (?, ?)");
      put.run("imported_at", new Date().toISOString());
      put.run("imported_from", from);
      put.run("counts", JSON.stringify(countRows(db)));
    } finally {
      db.close();
    }
    const target = join(this.dir, `${source}.sqlite`);
    for (const ext of ["-wal", "-shm", "-journal"]) rmSync(target + ext, { force: true });
    renameSync(tmp, target);
    return describe(target, source);
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
