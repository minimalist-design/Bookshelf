import type { Database } from "bun:sqlite";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import type { CoverStore } from "../covers/store.ts";
import type { BooksRepo } from "../db/repo/books.ts";
import type { EventBus } from "../events.ts";
import type { Library } from "../library/library.ts";
import { validateShelfName } from "../library/paths.ts";
import type { BookFormat, BulkRenameResult, CleanupResult, MaintenanceStats, MissingBookDto } from "../../shared/types.ts";
import { UnavailableError } from "../api/http.ts";
import type { BookService } from "./bookService.ts";

export interface MaintenanceDeps {
  config: AppConfig;
  db: Database;
  library: Library;
  books: BooksRepo;
  covers: CoverStore;
  bookService: BookService;
  events: EventBus;
}

const count = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;

/** Housekeeping: metadata without files, cover files, caches, bulk filename normalization. */
export class MaintenanceService {
  constructor(private readonly deps: MaintenanceDeps) {}

  /** The index must be complete before deciding what is "missing". */
  private async ready(): Promise<void> {
    const { library } = this.deps;
    if (!library.rootPath) throw new UnavailableError("No library directory is configured");
    await library.whenReady();
    if (library.status().state === "unavailable") throw new UnavailableError("The library directory is not accessible");
  }

  private missingIds(): number[] {
    return this.deps.books.allIds().filter((id) => !this.deps.library.index.hasBook(id));
  }

  async missing(): Promise<MissingBookDto[]> {
    await this.ready();
    const ids = this.missingIds();
    const records = this.deps.books.getMany(ids);
    const formats = new Map<number, Set<BookFormat>>();
    if (ids.length) {
      const rows = this.deps.db.query("SELECT book_id, format FROM book_hashes").all() as { book_id: number; format: BookFormat }[];
      for (const r of rows) {
        if (!records.has(r.book_id)) continue;
        let s = formats.get(r.book_id);
        if (!s) formats.set(r.book_id, (s = new Set()));
        s.add(r.format);
      }
    }
    return [...records.values()]
      .map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        isbn13: b.isbn13,
        doi: b.doi,
        confirmedSource: b.confirmedSource,
        hasCover: b.hasCover,
        formats: [...(formats.get(b.id) ?? [])].sort(),
        updatedAt: b.updatedAt,
      }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
  }

  /**
   * Permanently forget metadata of books that have no files on disk (confirmed or not).
   * Books currently on disk are never touched.
   */
  async forget(ids: number[]): Promise<CleanupResult> {
    await this.ready();
    const { library, books, covers, events } = this.deps;
    return library.linker.exclusive(() => {
      const doomed = ids.filter((id) => books.exists(id) && !library.index.hasBook(id));
      books.deleteMany(doomed);
      covers.removeMany(doomed);
      events.libraryChanged(doomed);
      return { removedBooks: doomed.length, removedCoverFiles: 0 };
    });
  }

  /**
   * Manual version of the startup cleanup (without the empty-library guard, since the user asked):
   * drop unconfirmed rows without files, plus cover files that belong to no book.
   */
  async cleanup(): Promise<CleanupResult> {
    await this.ready();
    const { library, books, events } = this.deps;
    const removed = await library.linker.exclusive(() => {
      const doomed = this.missingIds().filter((id) => books.confirmedSource(id) === null);
      books.deleteMany(doomed);
      this.deps.covers.removeMany(doomed);
      return doomed;
    });
    events.libraryChanged(removed);
    return { removedBooks: removed.length, removedCoverFiles: this.removeOrphanCovers() };
  }

  /** Normalize filenames of every book on a shelf ("" = Unshelved) or in the whole library (undefined). */
  async normalize(shelf: string | null | undefined): Promise<BulkRenameResult> {
    await this.ready();
    const target = shelf === undefined ? undefined : shelf === null || shelf === "" ? null : validateShelfName(shelf);
    const ids = new Set<number>();
    for (const f of this.deps.library.index.allFiles()) if (target === undefined || f.shelf === target) ids.add(f.bookId);
    return this.deps.bookService.normalizeFilenames([...ids]);
  }

  clearHttpCache(): number {
    return this.deps.db.query("DELETE FROM http_cache").run().changes;
  }

  stats(): MaintenanceStats {
    const { db, library, config } = this.deps;
    const missing = this.missingIds();
    const missingConfirmed = missing.filter((id) => this.deps.books.confirmedSource(id) !== null).length;
    const covers = this.coverFiles();
    const bookIds = new Set(this.deps.books.allIds());
    let dbBytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        dbBytes += statSync(config.dbPath + suffix).size;
      } catch {
        /* absent */
      }
    }
    return {
      booksOnDisk: library.index.bookIds().length,
      filesOnDisk: library.index.size,
      metadataRows: bookIds.size,
      confirmed: count(db, "SELECT count(*) AS n FROM books WHERE confirmed_source IS NOT NULL"),
      missing: missing.length,
      missingUnconfirmed: missing.length - missingConfirmed,
      reviewQueue: count(db, "SELECT count(*) AS n FROM review_queue"),
      hashCacheEntries: count(db, "SELECT count(*) AS n FROM file_hash_cache"),
      httpCacheEntries: count(db, "SELECT count(*) AS n FROM http_cache"),
      coverFiles: covers.length,
      coverBytes: covers.reduce((n, c) => n + c.size, 0),
      orphanCoverFiles: covers.filter((c) => c.bookId === null || !bookIds.has(c.bookId)).length,
      databaseBytes: dbBytes,
    };
  }

  private coverFiles(): { path: string; bookId: number | null; size: number }[] {
    const dir = this.deps.config.coversDir;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.map((name) => {
      const m = /^(\d+)\.(jpg|thumb\.webp)$/.exec(name);
      let size = 0;
      try {
        size = statSync(join(dir, name)).size;
      } catch {
        /* vanished */
      }
      return { path: join(dir, name), bookId: m ? Number(m[1]) : null, size };
    });
  }

  /** Cover files whose book row no longer exists (and stray temp files). */
  private removeOrphanCovers(): number {
    const ids = new Set(this.deps.books.allIds());
    let removed = 0;
    for (const c of this.coverFiles()) {
      if (c.bookId !== null && ids.has(c.bookId)) continue;
      rmSync(c.path, { force: true });
      removed++;
    }
    return removed;
  }
}
