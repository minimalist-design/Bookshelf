/** Housekeeping: metadata without files, cover files, caches, bulk filename normalization. */
import { rmSync, statSync } from "node:fs";
import type { AppContext } from "../app.ts";
import * as coverStore from "../covers/store.ts";
import * as bookRepo from "../db/repo/books.ts";
import type { BookRecord } from "../db/repo/books.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import * as httpCacheRepo from "../db/repo/httpCache.ts";
import * as isbndbRecords from "../db/repo/isbndbRecords.ts";
import * as reviewRepo from "../db/repo/reviewQueue.ts";
import { libraryReady } from "../library/library.ts";
import { validateShelfName } from "../library/paths.ts";
import { applyRules } from "../metadata/rules.ts";
import { pickMetadata } from "../metadata/types.ts";
import type { BookFormat, BulkRenameResult, CleanupResult, MaintenanceStats, MetadataRulesResult, MissingBookDto } from "../../shared/types.ts";
import { normalizeFilenames } from "./books.ts";

type Deps = Pick<AppContext, "db" | "library" | "config" | "events">;

/** Books with metadata but no file on disk. */
function missingIds(deps: Pick<AppContext, "db" | "library">): number[] {
  return bookRepo.allIds(deps.db).filter((id) => !deps.library.index.hasBook(id));
}

/** A book without files, as listed for review: its formats sorted, the list by title. */
export function missingBooks(records: Iterable<BookRecord>, formats: ReadonlyMap<number, readonly BookFormat[]>): MissingBookDto[] {
  return [...records]
    .map((b) => ({
      id: b.id,
      title: b.title,
      authors: b.authors,
      isbn13: b.isbn13,
      doi: b.doi,
      confirmedSource: b.confirmedSource,
      hasCover: b.hasCover,
      formats: [...(formats.get(b.id) ?? [])],
      updatedAt: b.updatedAt,
    }))
    .toSorted((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
}

/** The index must be complete before deciding what is "missing". */
export async function missing(deps: Pick<AppContext, "db" | "library">): Promise<MissingBookDto[]> {
  await libraryReady(deps.library);
  const ids = missingIds(deps);
  const formats = ids.length ? bookRepo.formatsByBook(deps.db) : new Map<number, BookFormat[]>();
  return missingBooks(bookRepo.getMany(deps.db, ids).values(), formats);
}

/**
 * Permanently forget metadata of books that have no files on disk (confirmed or not).
 * Books currently on disk are never touched.
 */
export async function forget(deps: Deps, ids: readonly number[]): Promise<CleanupResult> {
  await libraryReady(deps.library);
  const { db, library, events } = deps;
  return library.linker.exclusive(() => {
    const doomed = ids.filter((id) => bookRepo.exists(db, id) && !library.index.hasBook(id));
    bookRepo.removeMany(db, doomed);
    coverStore.removeMany(deps.config.coversDir, doomed);
    events.libraryChanged(doomed);
    return { removedBooks: doomed.length, removedCoverFiles: 0 };
  });
}

/**
 * Manual version of the startup cleanup (without the empty-library guard, since the user asked):
 * drop unconfirmed rows without files, plus cover files that belong to no book.
 */
export async function cleanup(deps: Deps): Promise<CleanupResult> {
  await libraryReady(deps.library);
  const { db, library, events } = deps;
  const removed = await library.linker.exclusive(() => {
    const doomed = missingIds(deps).filter((id) => bookRepo.confirmedSource(db, id) === null);
    bookRepo.removeMany(db, doomed);
    coverStore.removeMany(deps.config.coversDir, doomed);
    return doomed;
  });
  events.libraryChanged(removed);
  return { removedBooks: removed.length, removedCoverFiles: removeOrphanCovers(deps) };
}

/**
 * Run the built-in metadata rules (`metadata/rules.ts`) over every book whose metadata isn't
 * confirmed: imports already get them, this fixes books added before a rule existed. Confirmed
 * metadata (looked up or edited) is left as it is. Files are not renamed.
 */
export async function applyMetadataRules(deps: Deps): Promise<MetadataRulesResult> {
  await libraryReady(deps.library);
  const { db, library, events } = deps;
  const changed = await library.linker.exclusive(() => {
    const changes = [...bookRepo.getMany(db, bookRepo.allIds(db)).values()]
      .filter((b) => b.confirmedSource === null)
      .map((b) => ({ id: b.id, before: pickMetadata(b) }))
      .map(({ id, before }) => ({ id, before, after: applyRules(before) }))
      .filter(({ before, after }) => after !== before);
    for (const { id, after } of changes) bookRepo.updateMetadata(db, id, after, null);
    return changes.map((c) => c.id);
  });
  if (changed.length) events.libraryChanged(changed);
  return { changed: changed.length };
}

/** Normalize filenames of every book on a shelf ("" = Unshelved) or in the whole library (undefined). */
export async function normalize(deps: Deps, shelf: string | null | undefined): Promise<BulkRenameResult> {
  await libraryReady(deps.library);
  const target = shelf === undefined ? undefined : shelf === null || shelf === "" ? null : validateShelfName(shelf);
  const files = deps.library.index.allFiles().filter((f) => target === undefined || f.shelf === target);
  return normalizeFilenames(deps, [...new Set(files.map((f) => f.bookId))]);
}

export function clearHttpCache(deps: Pick<AppContext, "db">): number {
  return httpCacheRepo.clear(deps.db);
}

/** Size of the database with its write-ahead log and shared memory files. */
function databaseBytes(dbPath: string): number {
  return ["", "-wal", "-shm"]
    .map((suffix) => {
      try {
        return statSync(dbPath + suffix).size;
      } catch {
        return 0; // absent
      }
    })
    .reduce((a, b) => a + b, 0);
}

export function stats(deps: Pick<AppContext, "db" | "library" | "config">): MaintenanceStats {
  const { db, library, config } = deps;
  const missingBooks = missingIds(deps);
  const missingConfirmed = missingBooks.filter((id) => bookRepo.confirmedSource(db, id) !== null).length;
  const covers = coverStore.listFiles(config.coversDir);
  const bookIds = new Set(bookRepo.allIds(db));
  const isbndbCovers = isbndbRecords.coverStats(db);
  return {
    booksOnDisk: library.index.bookIds().length,
    filesOnDisk: library.index.size,
    metadataRows: bookIds.size,
    confirmed: bookRepo.confirmedCount(db),
    missing: missingBooks.length,
    missingUnconfirmed: missingBooks.length - missingConfirmed,
    reviewQueue: reviewRepo.count(db),
    hashCacheEntries: hashCacheRepo.count(db),
    httpCacheEntries: httpCacheRepo.count(db),
    isbndbRecords: isbndbRecords.count(db),
    isbndbCovers: isbndbCovers.files,
    isbndbCoverBytes: isbndbCovers.bytes,
    coverFiles: covers.length,
    coverBytes: covers.reduce((n, c) => n + c.size, 0),
    orphanCoverFiles: covers.filter((c) => c.bookId === null || !bookIds.has(c.bookId)).length,
    databaseBytes: databaseBytes(config.dbPath),
  };
}

/** Cover files whose book row no longer exists (and stray temp files). */
function removeOrphanCovers(deps: Pick<AppContext, "db" | "config">): number {
  const ids = new Set(bookRepo.allIds(deps.db));
  const orphans = coverStore.listFiles(deps.config.coversDir).filter((c) => c.bookId === null || !ids.has(c.bookId));
  for (const c of orphans) rmSync(c.path, { force: true });
  return orphans.length;
}
