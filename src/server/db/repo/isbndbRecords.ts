import type { Database } from "bun:sqlite";

/** Which ISBNdb call a record came from. */
export type IsbndbVia = "book" | "bulk" | "search";

/** A record as ISBNdb sent it: only the fields Bookshelf reads are named; every other field is kept too. */
export interface IsbndbRecord {
  isbn13?: string;
  isbn?: string;
  title?: string;
  authors?: string[];
  image?: string;
  image_original?: string;
  [field: string]: unknown;
}

export type CoverState = "done" | "none" | "failed";

/**
 * The permanent local copy of ISBNdb records (see migrations 008 and 009), with their cover images. A record
 * is replaced only by a newer answer for the same ISBN (its cover is downloaded again only when the
 * image changed); nothing is ever expired or cleared.
 */
export class IsbndbRecordsRepo {
  /** Called after records were stored (the cover downloader starts on them). */
  onStored: (() => void) | null = null;

  constructor(private readonly db: Database) {}

  /** Store records (those without an ISBN-13 are skipped); returns how many were stored. */
  putMany(records: readonly IsbndbRecord[], via: IsbndbVia, isbnOf: (r: IsbndbRecord) => string | null): number {
    const upsert = this.db.query(
      `INSERT INTO isbndb_records (isbn13, title, authors, record, via) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(isbn13) DO UPDATE SET title = excluded.title, authors = excluded.authors, record = excluded.record,
         via = excluded.via, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         -- \`image_original\` is a new temporary link in every answer: only a changed \`image\` means a new cover.
         cover_state = CASE WHEN json_extract(isbndb_records.record, '$.image') IS json_extract(excluded.record, '$.image')
           THEN isbndb_records.cover_state ELSE NULL END`,
    );
    const stored = this.db.transaction(() =>
      records.reduce((n, r) => {
        const isbn = isbnOf(r);
        if (!isbn) return n;
        upsert.run(isbn, typeof r.title === "string" ? r.title : null, JSON.stringify(Array.isArray(r.authors) ? r.authors : []), JSON.stringify(r), via);
        return n + 1;
      }, 0),
    )();
    if (stored) this.onStored?.();
    return stored;
  }

  get(isbn13: string): IsbndbRecord | null {
    const row = this.db.query("SELECT record FROM isbndb_records WHERE isbn13 = ?").get(isbn13) as { record: string } | null;
    return row ? (JSON.parse(row.record) as IsbndbRecord) : null;
  }

  has(isbn13: string): boolean {
    return this.db.query("SELECT 1 FROM isbndb_records WHERE isbn13 = ?").get(isbn13) !== null;
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM isbndb_records").get() as { n: number }).n;
  }

  /**
   * Records whose title or authors contain `word` (any case), at most `limit`: the starting set for
   * searching the copy (the caller checks every word).
   */
  containing(word: string, limit = 500): IsbndbRecord[] {
    const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .query("SELECT record FROM isbndb_records WHERE title LIKE ?1 ESCAPE '\\' OR authors LIKE ?1 ESCAPE '\\' LIMIT ?2")
      .all(like, limit) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as IsbndbRecord);
  }

  /** Records whose cover is still to be downloaded, oldest first (an `image_original` link expires 2 h after it was sent). */
  pendingCovers(limit: number): { isbn13: string; record: IsbndbRecord; fetchedAt: string }[] {
    const rows = this.db
      .query("SELECT isbn13, record, fetched_at FROM isbndb_records WHERE cover_state IS NULL ORDER BY fetched_at LIMIT ?")
      .all(limit) as { isbn13: string; record: string; fetched_at: string }[];
    return rows.map((r) => ({ isbn13: r.isbn13, record: JSON.parse(r.record) as IsbndbRecord, fetchedAt: r.fetched_at }));
  }

  setCover(isbn13: string, state: CoverState, file: string | null = null, bytes: number | null = null): void {
    this.db.query("UPDATE isbndb_records SET cover_state = ?, cover_file = ?, cover_bytes = ? WHERE isbn13 = ?").run(state, file, bytes, isbn13);
  }

  /** The downloaded cover's file name, if there is one. */
  coverFile(isbn13: string): string | null {
    const row = this.db.query("SELECT cover_file FROM isbndb_records WHERE isbn13 = ? AND cover_state = 'done'").get(isbn13) as
      | { cover_file: string | null }
      | null;
    return row?.cover_file ?? null;
  }

  coverStats(): { files: number; bytes: number; pending: number } {
    return this.db
      .query(
        `SELECT COALESCE(SUM(cover_state = 'done'), 0) AS files, COALESCE(SUM(CASE WHEN cover_state = 'done' THEN cover_bytes END), 0) AS bytes,
           COALESCE(SUM(cover_state IS NULL), 0) AS pending FROM isbndb_records`,
      )
      .get() as { files: number; bytes: number; pending: number };
  }
}
