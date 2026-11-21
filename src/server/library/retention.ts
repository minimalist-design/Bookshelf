import type { Database } from "bun:sqlite";
import * as bookRepo from "../db/repo/books.ts";
import type { LibraryIndex } from "./libraryIndex.ts";

export interface RetentionDeps {
  db: Database;
  index: LibraryIndex;
  /** Called after rows were deleted (remove covers, notify clients). */
  onDeleted: (bookIds: number[]) => void;
}

/**
 * Applies the metadata retention rule when a book's last file is gone: confirmed metadata (external source or
 * manual edit) is kept, everything else is deleted. In-app deletes apply it at once; files removed outside
 * Bookshelf are noticed at the end of the next full scan, after moves have been matched up.
 */
export interface Retention {
  /** Apply the rule now (in-app deletes). Returns the ids actually deleted. */
  evaluate(bookIds: readonly number[]): number[];
  /**
   * After a full scan: drop unconfirmed rows that have no file on disk. Guarded against
   * an unavailable library (e.g. unmounted drive): skipped when the scan found nothing
   * while metadata exists.
   */
  reconcile(filesFound: number): { deleted: number[]; skipped: boolean };
}

/** A scan that found no files while metadata exists more likely hit an unmounted drive than an empty library. */
export function looksUnavailable(filesFound: number, metadataRows: number): boolean {
  return filesFound === 0 && metadataRows > 0;
}

export function createRetention(deps: RetentionDeps): Retention {
  const { db, index } = deps;

  const evaluate = (bookIds: readonly number[]): number[] => {
    const doomed = bookIds.filter((id) => !index.hasBook(id) && bookRepo.exists(db, id) && bookRepo.confirmedSource(db, id) === null);
    if (doomed.length) {
      bookRepo.removeMany(db, doomed);
      deps.onDeleted(doomed);
    }
    return doomed;
  };

  return {
    evaluate,
    reconcile(filesFound) {
      if (looksUnavailable(filesFound, bookRepo.count(db))) return { deleted: [], skipped: true };
      return { deleted: evaluate(bookRepo.allIds(db).filter((id) => !index.hasBook(id))), skipped: false };
    },
  };
}
