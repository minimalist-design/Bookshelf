import type { Database } from "bun:sqlite";
import { toSortName } from "../../naming/authors.ts";
import type { BookFormat } from "../../naming/formats.ts";
import type { BookMetadata, MetadataSource } from "../../metadata/types.ts";

export type ConfirmedSource = "openlibrary" | "doi" | "manual";

export interface BookRecord extends BookMetadata {
  id: number;
  sortTitle: string | null;
  rating: number | null;
  notes: string | null;
  hasCover: boolean;
  coverSource: string | null;
  olEditionKey: string | null;
  olWorkKey: string | null;
  metadataSource: MetadataSource | null;
  confirmedSource: ConfirmedSource | null;
  confirmedAt: string | null;
  readingPosition: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BookRow {
  id: number;
  title: string;
  sort_title: string | null;
  subtitle: string | null;
  isbn13: string | null;
  doi: string | null;
  publisher: string | null;
  published_date: string | null;
  year: number | null;
  language: string | null;
  pages: number | null;
  description: string | null;
  series: string | null;
  series_index: number | null;
  rating: number | null;
  notes: string | null;
  has_cover: number;
  cover_source: string | null;
  ol_edition_key: string | null;
  ol_work_key: string | null;
  metadata_source: MetadataSource | null;
  confirmed_source: ConfirmedSource | null;
  confirmed_at: string | null;
  reading_position: string | null;
  created_at: string;
  updated_at: string;
}

const ARTICLES = /^(the|a|an|der|die|das|le|la|les|el|los|las|il|lo|gli)\s+/i;

export function sortTitleOf(title: string): string {
  return title.replace(ARTICLES, "").trim().toLowerCase();
}

/**
 * Turn free text into a safe FTS5 query: each whitespace-separated term becomes a quoted
 * prefix phrase (so operators and punctuation are literal), and all terms must match.
 */
export function toFtsQuery(q: string): string | null {
  const terms = q
    .normalize("NFKC")
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  return terms.length ? terms.map((t) => `"${t}"*`).join(" ") : null;
}

export class BooksRepo {
  constructor(private readonly db: Database) {}

  // ---- lookup -------------------------------------------------------------

  bookIdByHash(hash: string): number | null {
    const row = this.db.query("SELECT book_id FROM book_hashes WHERE hash = ?").get(hash) as { book_id: number } | null;
    return row?.book_id ?? null;
  }

  /** Books sharing the given ISBN-13 or DOI, oldest first. */
  bookIdsByIdentifiers(isbn13: string | null, doi: string | null): number[] {
    if (!isbn13 && !doi) return [];
    const rows = this.db
      .query(
        `SELECT id FROM books
         WHERE (?1 IS NOT NULL AND isbn13 = ?1) OR (?2 IS NOT NULL AND lower(doi) = lower(?2))
         ORDER BY id`,
      )
      .all(isbn13, doi) as { id: number }[];
    return rows.map((r) => r.id);
  }

  exists(id: number): boolean {
    return this.db.query("SELECT 1 FROM books WHERE id = ?").get(id) !== null;
  }

  allIds(): number[] {
    return (this.db.query("SELECT id FROM books").all() as { id: number }[]).map((r) => r.id);
  }

  count(): number {
    return (this.db.query("SELECT count(*) AS n FROM books").get() as { n: number }).n;
  }

  confirmedSource(id: number): ConfirmedSource | null {
    const row = this.db.query("SELECT confirmed_source FROM books WHERE id = ?").get(id) as
      | { confirmed_source: ConfirmedSource | null }
      | null;
    return row?.confirmed_source ?? null;
  }

  get(id: number): BookRecord | null {
    return this.getMany([id]).get(id) ?? null;
  }

  getMany(ids: readonly number[]): Map<number, BookRecord> {
    const out = new Map<number, BookRecord>();
    if (ids.length === 0) return out;
    // Chunk to stay well below SQLite's parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const marks = chunk.map(() => "?").join(",");
      const rows = this.db.query(`SELECT * FROM books WHERE id IN (${marks})`).all(...chunk) as BookRow[];
      const authors = this.db
        .query(
          `SELECT ba.book_id, a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
           WHERE ba.book_id IN (${marks}) ORDER BY ba.book_id, ba.position`,
        )
        .all(...chunk) as { book_id: number; name: string }[];
      const tags = this.db
        .query(
          `SELECT bt.book_id, t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
           WHERE bt.book_id IN (${marks}) ORDER BY t.name COLLATE NOCASE`,
        )
        .all(...chunk) as { book_id: number; name: string }[];
      for (const r of rows) out.set(r.id, toRecord(r));
      for (const a of authors) out.get(a.book_id)?.authors.push(a.name);
      for (const t of tags) out.get(t.book_id)?.tags.push(t.name);
    }
    return out;
  }

  /** Book ids matching a full-text query. */
  search(q: string): Set<number> {
    const fts = toFtsQuery(q);
    if (!fts) return new Set();
    const rows = this.db.query("SELECT rowid AS id FROM books_fts WHERE books_fts MATCH ?").all(fts) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }

  // ---- mutation -----------------------------------------------------------

  create(meta: BookMetadata, source: MetadataSource): number {
    return this.db.transaction(() => {
      const res = this.db
        .query(
          `INSERT INTO books (title, sort_title, subtitle, isbn13, doi, publisher, published_date, year, language,
                              pages, description, series, series_index, metadata_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meta.title,
          sortTitleOf(meta.title),
          meta.subtitle,
          meta.isbn13,
          meta.doi,
          meta.publisher,
          meta.publishedDate,
          meta.year,
          meta.language,
          meta.pages,
          meta.description,
          meta.series,
          meta.seriesIndex,
          source,
        );
      const id = Number(res.lastInsertRowid);
      this.setAuthors(id, meta.authors);
      this.setTags(id, meta.tags);
      this.refreshFts(id);
      return id;
    })();
  }

  /** Replace the descriptive metadata of a book (authors, tags and the search index included). */
  updateMetadata(id: number, meta: BookMetadata, source: MetadataSource | null): void {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE books SET title = ?, sort_title = ?, subtitle = ?, isbn13 = ?, doi = ?, publisher = ?,
             published_date = ?, year = ?, language = ?, pages = ?, description = ?, series = ?, series_index = ?,
             metadata_source = COALESCE(?, metadata_source),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
        .run(
          meta.title,
          sortTitleOf(meta.title),
          meta.subtitle,
          meta.isbn13,
          meta.doi,
          meta.publisher,
          meta.publishedDate,
          meta.year,
          meta.language,
          meta.pages,
          meta.description,
          meta.series,
          meta.seriesIndex,
          source,
          id,
        );
      this.setAuthors(id, meta.authors);
      this.setTags(id, meta.tags);
      this.pruneOrphans();
      this.refreshFts(id);
    })();
  }

  /** Personal fields that are not descriptive metadata. */
  updateExtras(id: number, extras: { rating?: number | null; notes?: string | null }): void {
    if (extras.rating !== undefined) this.db.query("UPDATE books SET rating = ? WHERE id = ?").run(extras.rating, id);
    if (extras.notes !== undefined) this.db.query("UPDATE books SET notes = ? WHERE id = ?").run(extras.notes, id);
    this.db.query("UPDATE books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
  }

  /**
   * Mark metadata as confirmed (kept even when the book's files disappear).
   * An external confirmation is never downgraded to "manual".
   */
  confirm(id: number, source: ConfirmedSource): void {
    this.db
      .query(
        `UPDATE books SET confirmed_source = ?1, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?2 AND (confirmed_source IS NULL OR ?1 <> 'manual')`,
      )
      .run(source, id);
  }

  /** Reader state; deliberately does not touch updated_at (not a metadata change). */
  setReadingPosition(id: number, json: string | null): void {
    this.db.query("UPDATE books SET reading_position = ? WHERE id = ?").run(json, id);
  }

  setOpenLibraryKeys(id: number, edition: string | null, work: string | null): void {
    this.db.query("UPDATE books SET ol_edition_key = ?, ol_work_key = ? WHERE id = ?").run(edition, work, id);
  }

  /** Re-assign every known content hash of `fromId` to `toId`. */
  moveHashes(fromId: number, toId: number): void {
    this.db.query("UPDATE book_hashes SET book_id = ? WHERE book_id = ?").run(toId, fromId);
  }

  deleteHash(hash: string): void {
    this.db.query("DELETE FROM book_hashes WHERE hash = ?").run(hash);
  }

  addHash(hash: string, bookId: number, format: BookFormat): void {
    this.db
      .query(
        `INSERT INTO book_hashes (hash, book_id, format) VALUES (?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET book_id = excluded.book_id, format = excluded.format`,
      )
      .run(hash, bookId, format);
  }

  setHasCover(id: number, hasCover: boolean, source: string | null): void {
    this.db.query("UPDATE books SET has_cover = ?, cover_source = ? WHERE id = ?").run(hasCover ? 1 : 0, source, id);
  }

  /** Deletes the row; hashes, author/tag links cascade. Orphaned authors/tags are pruned. */
  delete(id: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM books_fts WHERE rowid = ?").run(id);
      this.db.query("DELETE FROM books WHERE id = ?").run(id);
      this.pruneOrphans();
    })();
  }

  deleteMany(ids: readonly number[]): void {
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.query("DELETE FROM books_fts WHERE rowid = ?").run(id);
        this.db.query("DELETE FROM books WHERE id = ?").run(id);
      }
      this.pruneOrphans();
    })();
  }

  private setAuthors(bookId: number, names: readonly string[]): void {
    this.db.query("DELETE FROM book_authors WHERE book_id = ?").run(bookId);
    const upsert = this.db.query(
      "INSERT INTO authors (name, sort_name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id",
    );
    const link = this.db.query("INSERT OR IGNORE INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)");
    names.forEach((name, i) => {
      const { id } = upsert.get(name, toSortName(name)) as { id: number };
      link.run(bookId, id, i);
    });
  }

  private setTags(bookId: number, names: readonly string[]): void {
    this.db.query("DELETE FROM book_tags WHERE book_id = ?").run(bookId);
    const upsert = this.db.query(
      "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id",
    );
    const link = this.db.query("INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)");
    for (const name of names) {
      const { id } = upsert.get(name) as { id: number };
      link.run(bookId, id);
    }
  }

  private refreshFts(id: number): void {
    const b = this.get(id);
    this.db.query("DELETE FROM books_fts WHERE rowid = ?").run(id);
    if (!b) return;
    this.db
      .query(
        `INSERT INTO books_fts (rowid, title, subtitle, authors, isbn13, doi, series, tags, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, b.title, b.subtitle ?? "", b.authors.join(" "), b.isbn13 ?? "", b.doi ?? "", b.series ?? "", b.tags.join(" "), b.description ?? "");
  }

  private pruneOrphans(): void {
    this.db.exec("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors)");
    this.db.exec("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM book_tags)");
  }
}

function toRecord(r: BookRow): BookRecord {
  return {
    id: r.id,
    title: r.title,
    sortTitle: r.sort_title,
    subtitle: r.subtitle,
    authors: [],
    isbn13: r.isbn13,
    doi: r.doi,
    publisher: r.publisher,
    publishedDate: r.published_date,
    year: r.year,
    language: r.language,
    pages: r.pages,
    description: r.description,
    series: r.series,
    seriesIndex: r.series_index,
    tags: [],
    rating: r.rating,
    notes: r.notes,
    hasCover: r.has_cover === 1,
    coverSource: r.cover_source,
    olEditionKey: r.ol_edition_key,
    olWorkKey: r.ol_work_key,
    metadataSource: r.metadata_source,
    confirmedSource: r.confirmed_source,
    confirmedAt: r.confirmed_at,
    readingPosition: r.reading_position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
