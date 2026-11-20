import { readdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import * as bookRepo from "../db/repo/books.ts";
import type { BookRecord } from "../db/repo/books.ts";
import { countBy } from "../collections.ts";
import { toSortName } from "../naming/authors.ts";
import type {
  FacetDto,
  LibraryFacets,
  BookDetailDto,
  BookFileDto,
  BookSummaryDto,
  LibraryPage,
  LibraryQuery,
  LibrarySort,
  MissingFilter,
  ShelfDto,
} from "../../shared/types.ts";
import type { IndexedFile, LibraryIndex } from "./libraryIndex.ts";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function fileDto(f: IndexedFile): BookFileDto {
  return {
    hash: f.hash,
    relPath: f.relPath,
    filename: f.filename,
    shelf: f.shelf,
    format: f.format,
    size: f.size,
    mtimeMs: f.mtimeMs,
  };
}

export function toSummary(b: BookRecord, files: readonly IndexedFile[]): BookSummaryDto {
  const shelves = [...new Set(files.map((f) => f.shelf))];
  return {
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    authors: b.authors,
    year: b.year,
    series: b.series,
    seriesIndex: b.seriesIndex,
    isbn13: b.isbn13,
    doi: b.doi,
    rating: b.rating,
    tags: b.tags,
    hasCover: b.hasCover,
    metadataSource: b.metadataSource,
    confirmedSource: b.confirmedSource,
    createdAt: b.createdAt,
    files: files.map(fileDto),
    shelves,
  };
}

export function toDetail(b: BookRecord, files: readonly IndexedFile[]): BookDetailDto {
  return {
    ...toSummary(b, files),
    publisher: b.publisher,
    edition: b.edition,
    publishedDate: b.publishedDate,
    language: b.language,
    pages: b.pages,
    description: b.description,
    notes: b.notes,
    olEditionKey: b.olEditionKey,
    olWorkKey: b.olWorkKey,
    confirmedAt: b.confirmedAt,
    updatedAt: b.updatedAt,
  };
}

/** Book ids currently on disk, optionally restricted to a shelf ("" = Unshelved). */
function idsOnShelf(index: LibraryIndex, shelf: string | undefined): number[] {
  if (shelf === undefined) return index.bookIds();
  const target = shelf === "" ? null : shelf;
  return [...new Set(index.allFiles().filter((f) => f.shelf === target).map((f) => f.bookId))];
}

const MISSING: Record<MissingFilter, (b: BookRecord) => boolean> = {
  id: (b) => !b.isbn13 && !b.doi,
  author: (b) => b.authors.length === 0,
  cover: (b) => !b.hasCover,
  description: (b) => !b.description,
};

function matchesFilters(b: BookRecord, files: readonly IndexedFile[], q: LibraryQuery): boolean {
  const eq = (a: string | null | undefined, v: string) => (a ?? "").toLowerCase() === v.toLowerCase();
  return (
    (!q.format || files.some((f) => f.format === q.format)) &&
    (!q.tag || b.tags.some((t) => eq(t, q.tag!))) &&
    (!q.series || eq(b.series, q.series)) &&
    (!q.author || b.authors.some((a) => eq(a, q.author!))) &&
    (q.confirmed === undefined || (b.confirmedSource !== null) === q.confirmed) &&
    (q.minRating === undefined || (b.rating ?? 0) >= q.minRating) &&
    (!q.missing || MISSING[q.missing](b))
  );
}

type Comparator = (a: BookRecord, b: BookRecord) => number;

const LAST = Number.MAX_SAFE_INTEGER;
const byTitle: Comparator = (a, b) => collator.compare(a.sortTitle ?? a.title, b.sortTitle ?? b.title);
const firstAuthor = (b: BookRecord) => (b.authors[0] ? toSortName(b.authors[0]) : "\uffff");

/** Comparators per sort key; `dir` is 1 (ascending) or -1 (descending). */
const SORTS: Record<LibrarySort, (dir: number) => Comparator> = {
  title: (dir) => (a, b) => dir * byTitle(a, b),
  author: (dir) => (a, b) => dir * (collator.compare(firstAuthor(a), firstAuthor(b)) || byTitle(a, b)),
  added: (dir) => (a, b) => dir * (a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
  year: (dir) => (a, b) => dir * ((a.year ?? LAST) - (b.year ?? LAST)) || byTitle(a, b),
  // Books without a series go last, regardless of direction.
  series: (dir) => (a, b) =>
    (a.series ? 0 : 1) - (b.series ? 0 : 1) ||
    dir * (collator.compare(a.series ?? "", b.series ?? "") || (a.seriesIndex ?? LAST) - (b.seriesIndex ?? LAST)) ||
    byTitle(a, b),
  rating: (dir) => (a, b) => dir * ((a.rating ?? -1) - (b.rating ?? -1)) || byTitle(a, b),
};

/** Books currently on disk, filtered/sorted/paged. Presence comes only from the index. */
export function listLibrary(index: LibraryIndex, db: Database, query: LibraryQuery): LibraryPage {
  const onShelf = idsOnShelf(index, query.shelf);
  const hits = query.q?.trim() ? bookRepo.search(db, query.q) : null;
  const ids = hits ? onShelf.filter((id) => hits.has(id)) : onShelf;

  const records = bookRepo.getMany(db, ids);
  const list = ids
    .map((id) => records.get(id))
    .filter((b): b is BookRecord => !!b && matchesFilters(b, index.filesOfBook(b.id), query))
    .toSorted(SORTS[query.sort ?? "title"](query.order === "desc" ? -1 : 1));

  const size = Math.min(Math.max(query.size ?? 100, 1), 500);
  const page = Math.max(query.page ?? 1, 1);
  const items = list.slice((page - 1) * size, page * size).map((b) => toSummary(b, index.filesOfBook(b.id)));
  return { items, total: list.length, page, size };
}

/** Facet entries for the non-empty values, sorted by name. */
function facet(values: readonly (string | null | undefined)[]): FacetDto[] {
  return countBy(values.filter((v): v is string => !!v)).toSorted((a, b) => collator.compare(a.name, b.name));
}

/** Counts of tags, series, authors, formats… among books currently on disk. */
export function libraryFacets(index: LibraryIndex, db: Database): LibraryFacets {
  const records = [...bookRepo.getMany(db, index.bookIds()).values()];
  return {
    tags: facet(records.flatMap((b) => b.tags)),
    series: facet(records.map((b) => b.series)),
    authors: facet(records.flatMap((b) => b.authors)),
    formats: facet(records.flatMap((b) => [...new Set(index.filesOfBook(b.id).map((f) => f.format))])),
    languages: facet(records.map((b) => b.language)),
    publishers: facet(records.map((b) => b.publisher)),
  };
}

/** First-level directories of the library root, or none when it can't be read. */
function readShelfDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return []; // root unavailable
  }
}

/** Shelves from the directory names plus any shelf the index still has files on, with book counts. */
export function shelvesFrom(dirs: readonly string[], files: Iterable<IndexedFile>): ShelfDto[] {
  const byShelf = Map.groupBy(files, (f) => f.shelf);
  const bookCount = (name: string | null) => new Set(byShelf.get(name)?.map((f) => f.bookId)).size;
  const named = [...byShelf.keys()].filter((name): name is string => name !== null);
  return [
    { name: null, bookCount: bookCount(null) },
    ...[...new Set([...dirs, ...named])].toSorted(collator.compare).map((name) => ({ name, bookCount: bookCount(name) })),
  ];
}

/** Shelves are the first-level directories on disk (empty ones included) plus Unshelved. */
export function listShelves(root: string, index: LibraryIndex): ShelfDto[] {
  return shelvesFrom(readShelfDirs(root), index.allFiles());
}
