import type { Database } from "bun:sqlite";
import { chunk } from "../../collections.ts";
import { toSortName } from "../../naming/authors.ts";
import type { BookFormat } from "../../naming/formats.ts";
import type { BookMetadata, MetadataSource } from "../../metadata/types.ts";
import type { CleanupField } from "../../../shared/types.ts";

export type ConfirmedSource = "isbndb" | "openlibrary" | "doi" | "manual";

export interface BookRecord extends BookMetadata {
  readonly id: number;
  readonly sortTitle: string | null;
  readonly rating: number | null;
  readonly notes: string | null;
  readonly hasCover: boolean;
  readonly coverSource: string | null;
  readonly olEditionKey: string | null;
  readonly olWorkKey: string | null;
  readonly metadataSource: MetadataSource | null;
  readonly confirmedSource: ConfirmedSource | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface NameRow {
  book_id: number;
  name: string;
}

interface BookRow {
  id: number;
  title: string;
  sort_title: string | null;
  subtitle: string | null;
  isbn13: string | null;
  doi: string | null;
  publisher: string | null;
  edition: string | null;
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


// ---- lookup -------------------------------------------------------------

export function bookIdByHash(db: Database, hash: string): number | null {
  const row = db.query("SELECT book_id FROM book_hashes WHERE hash = ?").get(hash) as { book_id: number } | null;
  return row?.book_id ?? null;
}

/** Books sharing the given ISBN-13 or DOI, oldest first. */
export function bookIdsByIdentifiers(db: Database, isbn13: string | null, doi: string | null): number[] {
  if (!isbn13 && !doi) return [];
  const rows = db
    .query(
      `SELECT id FROM books
       WHERE (?1 IS NOT NULL AND isbn13 = ?1) OR (?2 IS NOT NULL AND lower(doi) = lower(?2))
       ORDER BY id`,
    )
    .all(isbn13, doi) as { id: number }[];
  return rows.map((r) => r.id);
}

export function exists(db: Database, id: number): boolean {
  return db.query("SELECT 1 FROM books WHERE id = ?").get(id) !== null;
}

export function allIds(db: Database): number[] {
  return (db.query("SELECT id FROM books").all() as { id: number }[]).map((r) => r.id);
}

/** Books whose metadata was confirmed (looked up or edited). */
export function confirmedCount(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM books WHERE confirmed_source IS NOT NULL").get() as { n: number }).n;
}

/** The formats each book has had files in, sorted. */
export function formatsByBook(db: Database): Map<number, BookFormat[]> {
  const rows = db.query("SELECT DISTINCT book_id, format FROM book_hashes ORDER BY format").all() as { book_id: number; format: BookFormat }[];
  return new Map([...Map.groupBy(rows, (r) => r.book_id)].map(([id, list]) => [id, list.map((r) => r.format)]));
}

export function count(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM books").get() as { n: number }).n;
}

export function confirmedSource(db: Database, id: number): ConfirmedSource | null {
  const row = db.query("SELECT confirmed_source FROM books WHERE id = ?").get(id) as
    | { confirmed_source: ConfirmedSource | null }
    | null;
  return row?.confirmed_source ?? null;
}

export function get(db: Database, id: number): BookRecord | null {
  return getMany(db, [id]).get(id) ?? null;
}

export function getMany(db: Database, ids: readonly number[]): Map<number, BookRecord> {
  // Chunked to stay well below SQLite's parameter limit.
  return new Map(
    chunk(ids, 500).flatMap((part) => {
      const marks = part.map(() => "?").join(",");
      const rows = db.query(`SELECT * FROM books WHERE id IN (${marks})`).all(...part) as BookRow[];
      const authors = db
        .query(
          `SELECT ba.book_id, a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
           WHERE ba.book_id IN (${marks}) ORDER BY ba.book_id, ba.position`,
        )
        .all(...part) as NameRow[];
      const tags = db
        .query(
          `SELECT bt.book_id, t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
           WHERE bt.book_id IN (${marks}) ORDER BY t.name COLLATE NOCASE`,
        )
        .all(...part) as NameRow[];
      const namesOf = (list: readonly NameRow[]) => {
        const byBook = Map.groupBy(list, (r) => r.book_id);
        return (id: number) => byBook.get(id)?.map((r) => r.name) ?? [];
      };
      const [authorsOf, tagsOf] = [namesOf(authors), namesOf(tags)];
      return rows.map((r) => [r.id, toRecord(r, authorsOf(r.id), tagsOf(r.id))] as const);
    }),
  );
}

/** Book ids matching a full-text query. */
export function search(db: Database, q: string): Set<number> {
  const fts = toFtsQuery(q);
  if (!fts) return new Set();
  const rows = db.query("SELECT rowid AS id FROM books_fts WHERE books_fts MATCH ?").all(fts) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

// ---- mutation -----------------------------------------------------------

export function create(db: Database, meta: BookMetadata, source: MetadataSource): number {
  return db.transaction(() => {
    const res = db
      .query(
        `INSERT INTO books (title, sort_title, subtitle, isbn13, doi, publisher, edition, published_date, year, language,
                            pages, description, series, series_index, metadata_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.title,
        sortTitleOf(meta.title),
        meta.subtitle,
        meta.isbn13,
        meta.doi,
        meta.publisher,
        meta.edition,
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
    setAuthors(db, id, meta.authors);
    setTags(db, id, meta.tags);
    refreshFts(db, id);
    return id;
  })();
}

/** Replace the descriptive metadata of a book (authors, tags and the search index included). */
export function updateMetadata(db: Database, id: number, meta: BookMetadata, source: MetadataSource | null): void {
  db.transaction(() => {
    db
      .query(
        `UPDATE books SET title = ?, sort_title = ?, subtitle = ?, isbn13 = ?, doi = ?, publisher = ?, edition = ?,
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
        meta.edition,
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
    setAuthors(db, id, meta.authors);
    setTags(db, id, meta.tags);
    pruneOrphans(db, );
    refreshFts(db, id);
  })();
}

/** Personal fields that are not descriptive metadata. */
export function updateExtras(db: Database, id: number, extras: { rating?: number | null; notes?: string | null }): void {
  if (extras.rating !== undefined) db.query("UPDATE books SET rating = ? WHERE id = ?").run(extras.rating, id);
  if (extras.notes !== undefined) db.query("UPDATE books SET notes = ? WHERE id = ?").run(extras.notes, id);
  db.query("UPDATE books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

/**
 * Mark metadata as confirmed (kept even when the book's files disappear).
 * An external confirmation is never downgraded to "manual".
 */
export function confirm(db: Database, id: number, source: ConfirmedSource): void {
  db
    .query(
      `UPDATE books SET confirmed_source = ?1, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?2 AND (confirmed_source IS NULL OR ?1 <> 'manual')`,
    )
    .run(source, id);
}

export function setOpenLibraryKeys(db: Database, id: number, edition: string | null, work: string | null): void {
  db.query("UPDATE books SET ol_edition_key = ?, ol_work_key = ? WHERE id = ?").run(edition, work, id);
}

/** Re-assign every known content hash of `fromId` to `toId`. */
export function moveHashes(db: Database, fromId: number, toId: number): void {
  db.query("UPDATE book_hashes SET book_id = ? WHERE book_id = ?").run(toId, fromId);
}

export function deleteHash(db: Database, hash: string): void {
  db.query("DELETE FROM book_hashes WHERE hash = ?").run(hash);
}

export function addHash(db: Database, hash: string, bookId: number, format: BookFormat): void {
  db
    .query(
      `INSERT INTO book_hashes (hash, book_id, format) VALUES (?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET book_id = excluded.book_id, format = excluded.format`,
    )
    .run(hash, bookId, format);
}

/** Bumps updated_at, so clients know a cached cover image is stale. */
export function setHasCover(db: Database, id: number, hasCover: boolean, source: string | null): void {
  db
    .query("UPDATE books SET has_cover = ?, cover_source = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(hasCover ? 1 : 0, source, id);
}

/** Deletes the row; hashes, author/tag links cascade. Orphaned authors/tags are pruned. */
export function remove(db: Database, id: number): void {
  db.transaction(() => {
    db.query("DELETE FROM books_fts WHERE rowid = ?").run(id);
    db.query("DELETE FROM books WHERE id = ?").run(id);
    pruneOrphans(db, );
  })();
}

export function removeMany(db: Database, ids: readonly number[]): void {
  db.transaction(() => {
    for (const id of ids) {
      db.query("DELETE FROM books_fts WHERE rowid = ?").run(id);
      db.query("DELETE FROM books WHERE id = ?").run(id);
    }
    pruneOrphans(db, );
  })();
}

/** Whether some book (other than `exceptBookId`) has this author (any case). */
export function hasAuthor(db: Database, name: string, exceptBookId: number | null = null): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM authors a JOIN book_authors ba ON ba.author_id = a.id
         WHERE a.name = ?1 COLLATE NOCASE AND (?2 IS NULL OR ba.book_id <> ?2) LIMIT 1`,
      )
      .get(name, exceptBookId) !== null
  );
}

/** Every book row (on disk or not) with one of these authors, tags (any case), series or publishers. */
export function idsWithName(db: Database, field: CleanupField, names: readonly string[]): number[] {
  if (!names.length) return [];
  const marks = names.map(() => "?").join(", ");
  const sql = {
    authors: `SELECT DISTINCT ba.book_id AS id FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE a.name IN (${marks})`,
    tags: `SELECT DISTINCT bt.book_id AS id FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name IN (${marks})`,
    series: `SELECT id FROM books WHERE series IN (${marks})`,
    publishers: `SELECT id FROM books WHERE publisher IN (${marks})`,
  }[field];
  return (db.query(sql).all(...names) as { id: number }[]).map((r) => r.id);
}

/** Tags are unique regardless of case and keep their first spelling; this sets the spelling. */
export function setTagSpelling(db: Database, name: string): void {
  db.query("UPDATE tags SET name = ?1 WHERE name = ?1").run(name);
}

function setAuthors(db: Database, bookId: number, names: readonly string[]): void {
  db.query("DELETE FROM book_authors WHERE book_id = ?").run(bookId);
  const upsert = db.query(
    "INSERT INTO authors (name, sort_name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id",
  );
  const link = db.query("INSERT OR IGNORE INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)");
  for (const [i, name] of names.entries()) {
    const { id } = upsert.get(name, toSortName(name)) as { id: number };
    link.run(bookId, id, i);
  }
}

function setTags(db: Database, bookId: number, names: readonly string[]): void {
  db.query("DELETE FROM book_tags WHERE book_id = ?").run(bookId);
  const upsert = db.query(
    "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id",
  );
  const link = db.query("INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)");
  for (const name of names) {
    const { id } = upsert.get(name) as { id: number };
    link.run(bookId, id);
  }
}

function refreshFts(db: Database, id: number): void {
  const b = get(db, id);
  db.query("DELETE FROM books_fts WHERE rowid = ?").run(id);
  if (!b) return;
  db
    .query(
      `INSERT INTO books_fts (rowid, title, subtitle, authors, isbn13, doi, series, tags, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, b.title, b.subtitle ?? "", b.authors.join(" "), b.isbn13 ?? "", b.doi ?? "", b.series ?? "", b.tags.join(" "), b.description ?? "");
}

function pruneOrphans(db: Database): void {
  db.exec("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors)");
  db.exec("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM book_tags)");
}

function toRecord(r: BookRow, authors: readonly string[], tags: readonly string[]): BookRecord {
  return {
    id: r.id,
    title: r.title,
    sortTitle: r.sort_title,
    subtitle: r.subtitle,
    authors,
    isbn13: r.isbn13,
    doi: r.doi,
    publisher: r.publisher,
    edition: r.edition,
    publishedDate: r.published_date,
    year: r.year,
    language: r.language,
    pages: r.pages,
    description: r.description,
    series: r.series,
    seriesIndex: r.series_index,
    tags,
    rating: r.rating,
    notes: r.notes,
    hasCover: r.has_cover === 1,
    coverSource: r.cover_source,
    olEditionKey: r.ol_edition_key,
    olWorkKey: r.ol_work_key,
    metadataSource: r.metadata_source,
    confirmedSource: r.confirmed_source,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
