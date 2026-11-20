import type { Database } from "bun:sqlite";
import * as bookRepo from "../db/repo/books.ts";
import type { LibraryIndex } from "./libraryIndex.ts";

export interface RetentionDeps {
  db: Database;
  index: LibraryIndex;
  graceMs: number;
  /** Called after rows were deleted (remove covers, notify clients). */
  onDeleted: (bookIds: number[]) => void;
}

/**
 * Applies the metadata retention rule when a book's last file disappears:
 * confirmed metadata (external source or manual edit) is kept, everything else is deleted.
 * External removals wait `graceMs` first so that moves (remove + add) don't lose metadata.
 */
export interface Retention {
  /** A file of `bookId` vanished from disk (externally). */
  fileRemoved(bookId: number): void;
  /** A file of `bookId` (re)appeared: cancel any pending deletion. */
  fileAdded(bookId: number): void;
  /** Apply the rule immediately (in-app deletes). Returns the ids actually deleted. */
  evaluate(bookIds: readonly number[]): number[];
  /**
   * After a full scan: drop unconfirmed rows that have no file on disk. Guarded against
   * an unavailable library (e.g. unmounted drive): skipped when the scan found nothing
   * while metadata exists.
   */
  reconcile(filesFound: number): { deleted: number[]; skipped: boolean };
  stop(): void;
  pendingCount(): number;
}

/** A scan that found no files while metadata exists more likely hit an unmounted drive than an empty library. */
export function looksUnavailable(filesFound: number, metadataRows: number): boolean {
  return filesFound === 0 && metadataRows > 0;
}

export function createRetention(deps: RetentionDeps): Retention {
  const { db, index } = deps;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const evaluate = (bookIds: readonly number[]): number[] => {
    const doomed = bookIds.filter((id) => !index.hasBook(id) && bookRepo.exists(db, id) && bookRepo.confirmedSource(db, id) === null);
    if (doomed.length) {
      bookRepo.removeMany(db, doomed);
      deps.onDeleted(doomed);
    }
    return doomed;
  };

  return {
    fileRemoved(bookId) {
      if (index.hasBook(bookId) || timers.has(bookId)) return;
      timers.set(
        bookId,
        setTimeout(() => {
          timers.delete(bookId);
          evaluate([bookId]);
        }, deps.graceMs),
      );
    },
    fileAdded(bookId) {
      clearTimeout(timers.get(bookId));
      timers.delete(bookId);
    },
    evaluate,
    reconcile(filesFound) {
      if (looksUnavailable(filesFound, bookRepo.count(db))) return { deleted: [], skipped: true };
      return { deleted: evaluate(bookRepo.allIds(db).filter((id) => !index.hasBook(id))), skipped: false };
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    pendingCount: () => timers.size,
  };
}
