import type { BooksRepo } from "../db/repo/books.ts";
import type { LibraryIndex } from "./libraryIndex.ts";

export interface RetentionDeps {
  books: BooksRepo;
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
export class Retention {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: RetentionDeps) {}

  /** A file of `bookId` vanished from disk (externally). */
  fileRemoved(bookId: number): void {
    if (this.deps.index.hasBook(bookId) || this.timers.has(bookId)) return;
    this.timers.set(
      bookId,
      setTimeout(() => {
        this.timers.delete(bookId);
        this.evaluate([bookId]);
      }, this.deps.graceMs),
    );
  }

  /** A file of `bookId` (re)appeared: cancel any pending deletion. */
  fileAdded(bookId: number): void {
    const t = this.timers.get(bookId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(bookId);
    }
  }

  /** Apply the rule immediately (in-app deletes). Returns the ids actually deleted. */
  evaluate(bookIds: number[]): number[] {
    const { books, index } = this.deps;
    const doomed = bookIds.filter((id) => !index.hasBook(id) && books.exists(id) && books.confirmedSource(id) === null);
    if (doomed.length) {
      books.deleteMany(doomed);
      this.deps.onDeleted(doomed);
    }
    return doomed;
  }

  /**
   * After a full scan: drop unconfirmed rows that have no file on disk. Guarded against
   * an unavailable library (e.g. unmounted drive): skipped when the scan found nothing
   * while metadata exists.
   */
  reconcile(filesFound: number): { deleted: number[]; skipped: boolean } {
    const { books, index } = this.deps;
    if (filesFound === 0 && books.count() > 0) return { deleted: [], skipped: true };
    const missing = books.allIds().filter((id) => !index.hasBook(id));
    return { deleted: this.evaluate(missing), skipped: false };
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  pendingCount(): number {
    return this.timers.size;
  }
}
