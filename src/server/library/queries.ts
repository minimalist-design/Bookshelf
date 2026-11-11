import { readdirSync } from "node:fs";
import type { BookRecord, BooksRepo } from "../db/repo/books.ts";
import { toSortName } from "../naming/authors.ts";
import type {
  ReadingPosition,
  FacetDto,
  LibraryFacets,
  BookDetailDto,
  BookFileDto,
  BookSummaryDto,
  LibraryPage,
  LibraryQuery,
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

export function toSummary(b: BookRecord, files: IndexedFile[]): BookSummaryDto {
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
    progress: parsePosition(b.readingPosition)?.fraction ?? null,
  };
}

export function parsePosition(raw: string | null): ReadingPosition | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ReadingPosition;
    return typeof p?.hash === "string" && typeof p?.position === "string" ? p : null;
  } catch {
    return null;
  }
}

export function toDetail(b: BookRecord, files: IndexedFile[]): BookDetailDto {
  return {
    ...toSummary(b, files),
    publisher: b.publisher,
    publishedDate: b.publishedDate,
    language: b.language,
    pages: b.pages,
    description: b.description,
    notes: b.notes,
    olEditionKey: b.olEditionKey,
    olWorkKey: b.olWorkKey,
    confirmedAt: b.confirmedAt,
    readingPosition: parsePosition(b.readingPosition),
    updatedAt: b.updatedAt,
  };
}

/** Book ids currently on disk, optionally restricted to a shelf ("" = Unshelved). */
function idsOnShelf(index: LibraryIndex, shelf: string | undefined): number[] {
  if (shelf === undefined) return index.bookIds();
  const target = shelf === "" ? null : shelf;
  const set = new Set<number>();
  for (const f of index.allFiles()) if (f.shelf === target) set.add(f.bookId);
  return [...set];
}

function matchesFilters(b: BookRecord, files: IndexedFile[], q: LibraryQuery): boolean {
  const eq = (a: string | null | undefined, v: string) => (a ?? "").toLowerCase() === v.toLowerCase();
  if (q.format && !files.some((f) => f.format === q.format)) return false;
  if (q.tag && !b.tags.some((t) => eq(t, q.tag!))) return false;
  if (q.series && !eq(b.series, q.series)) return false;
  if (q.author && !b.authors.some((a) => eq(a, q.author!))) return false;
  if (q.confirmed !== undefined && (b.confirmedSource !== null) !== q.confirmed) return false;
  if (q.minRating !== undefined && (b.rating ?? 0) < q.minRating) return false;
  switch (q.missing) {
    case "id":
      return !b.isbn13 && !b.doi;
    case "author":
      return b.authors.length === 0;
    case "cover":
      return !b.hasCover;
    case "description":
      return !b.description;
  }
  return true;
}

/** Books currently on disk, filtered/sorted/paged. Presence comes only from the index. */
export function listLibrary(index: LibraryIndex, books: BooksRepo, query: LibraryQuery): LibraryPage {
  let ids = idsOnShelf(index, query.shelf);
  if (query.q?.trim()) {
    const hits = books.search(query.q);
    ids = ids.filter((id) => hits.has(id));
  }

  const records = books.getMany(ids);
  const list = ids
    .map((id) => records.get(id))
    .filter((b): b is BookRecord => !!b && matchesFilters(b, index.filesOfBook(b.id), query));
  const dir = query.order === "desc" ? -1 : 1;
  const byTitle = (a: BookRecord, b: BookRecord) => collator.compare(a.sortTitle ?? a.title, b.sortTitle ?? b.title);
  const firstAuthor = (b: BookRecord) => (b.authors[0] ? toSortName(b.authors[0]) : "\uffff");
  const LAST = Number.MAX_SAFE_INTEGER;
  switch (query.sort ?? "title") {
    case "author":
      list.sort((a, b) => dir * (collator.compare(firstAuthor(a), firstAuthor(b)) || byTitle(a, b)));
      break;
    case "added":
      list.sort((a, b) => dir * (a.createdAt.localeCompare(b.createdAt) || a.id - b.id));
      break;
    case "year":
      list.sort((a, b) => dir * ((a.year ?? LAST) - (b.year ?? LAST)) || byTitle(a, b));
      break;
    case "series":
      // Books without a series go last, regardless of direction.
      list.sort(
        (a, b) =>
          (a.series ? 0 : 1) - (b.series ? 0 : 1) ||
          dir * (collator.compare(a.series ?? "", b.series ?? "") || (a.seriesIndex ?? LAST) - (b.seriesIndex ?? LAST)) ||
          byTitle(a, b),
      );
      break;
    case "rating":
      list.sort((a, b) => dir * ((a.rating ?? -1) - (b.rating ?? -1)) || byTitle(a, b));
      break;
    default:
      list.sort((a, b) => dir * byTitle(a, b));
  }

  const size = Math.min(Math.max(query.size ?? 100, 1), 500);
  const page = Math.max(query.page ?? 1, 1);
  const items = list.slice((page - 1) * size, page * size).map((b) => toSummary(b, index.filesOfBook(b.id)));
  return { items, total: list.length, page, size };
}

/** Counts of tags, series, authors, formats… among books currently on disk. */
export function libraryFacets(index: LibraryIndex, books: BooksRepo): LibraryFacets {
  const counters = { tags: new Map<string, number>(), series: new Map<string, number>(), authors: new Map<string, number>(), formats: new Map<string, number>(), languages: new Map<string, number>(), publishers: new Map<string, number>() };
  const bump = (m: Map<string, number>, v: string | null | undefined) => v && m.set(v, (m.get(v) ?? 0) + 1);
  const records = books.getMany(index.bookIds());
  for (const b of records.values()) {
    b.tags.forEach((t) => bump(counters.tags, t));
    b.authors.forEach((a) => bump(counters.authors, a));
    bump(counters.series, b.series);
    bump(counters.languages, b.language);
    bump(counters.publishers, b.publisher);
    new Set(index.filesOfBook(b.id).map((f) => f.format)).forEach((f) => bump(counters.formats, f));
  }
  const sorted = (m: Map<string, number>): FacetDto[] =>
    [...m].map(([name, count]) => ({ name, count })).sort((a, b) => collator.compare(a.name, b.name));
  return {
    tags: sorted(counters.tags),
    series: sorted(counters.series),
    authors: sorted(counters.authors),
    formats: sorted(counters.formats),
    languages: sorted(counters.languages),
    publishers: sorted(counters.publishers),
  };
}

/** Shelves are the first-level directories on disk (empty ones included) plus Unshelved. */
export function listShelves(root: string, index: LibraryIndex): ShelfDto[] {
  const counts = new Map<string | null, Set<number>>();
  for (const f of index.allFiles()) {
    let s = counts.get(f.shelf);
    if (!s) counts.set(f.shelf, (s = new Set()));
    s.add(f.bookId);
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    /* root unavailable */
  }
  for (const name of counts.keys()) if (name !== null && !dirs.includes(name)) dirs.push(name);
  dirs.sort(collator.compare);
  return [
    { name: null, bookCount: counts.get(null)?.size ?? 0 },
    ...dirs.map((name) => ({ name, bookCount: counts.get(name)?.size ?? 0 })),
  ];
}
