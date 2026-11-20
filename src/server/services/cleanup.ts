/** Merging spelling variants of names into one, and remembering them as aliases. */
import { displayOrder, groupNames } from "../cleanup/similarity.ts";
import { swapSuspect } from "../cleanup/swaps.ts";
import { uniqueCaseless } from "../collections.ts";
import type { AppContext } from "../app.ts";
import * as bookRepo from "../db/repo/books.ts";
import { libraryReady } from "../library/library.ts";
import { ValidationError } from "../library/paths.ts";
import { libraryFacets } from "../library/queries.ts";
import type { BookMetadata } from "../metadata/types.ts";
import { parseFilename } from "../naming/parseFilename.ts";
import { openLibraryAuthorSearch } from "../sources/openlibrary.ts";
import { wikidataAuthorSearch } from "../sources/wikidata.ts";
import {
  CLEANUP_FIELDS,
  type AliasDto,
  type AuthorSearchDto,
  type BookRefDto,
  type CleanupField,
  type NameGroupsDto,
  type NameMergeResult,
  type SwapSuspectDto,
  type TitleAuthorFix,
} from "../../shared/types.ts";
import { errorMessage } from "./fileOps.ts";
import { renameBookFiles } from "./renameService.ts";

type Deps = Pick<AppContext, "db" | "library" | "events">;

const MAX_NAME = 200;

export function cleanupField(v: unknown): CleanupField {
  if (typeof v === "string" && (CLEANUP_FIELDS as readonly string[]).includes(v)) return v as CleanupField;
  throw new ValidationError(`field must be one of ${CLEANUP_FIELDS.join(", ")}`);
}

function name(v: unknown, what: string): string {
  if (typeof v !== "string") throw new ValidationError(`${what} must be text`);
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) throw new ValidationError(`${what} is empty`);
  if (t.length > MAX_NAME) throw new ValidationError(`${what} is too long`);
  return t;
}

type Replace = (meta: BookMetadata, hit: (v: string) => boolean, to: string) => BookMetadata;
const replaceList = (l: readonly string[], hit: (v: string) => boolean, to: string) => uniqueCaseless(l.map((v) => (hit(v) ? to : v)));

const REPLACERS: Record<CleanupField, Replace> = {
  authors: (meta, hit, to) => ({ ...meta, authors: replaceList(meta.authors, hit, to) }),
  tags: (meta, hit, to) => ({ ...meta, tags: replaceList(meta.tags, hit, to) }),
  series: (meta, hit, to) => (meta.series !== null && hit(meta.series) ? { ...meta, series: to } : meta),
  publishers: (meta, hit, to) => (meta.publisher !== null && hit(meta.publisher) ? { ...meta, publisher: to } : meta),
};

/** `meta` with every `from` name of `field` replaced by `to` (tags compare without case, as they are stored). */
export function replaceName(meta: BookMetadata, field: CleanupField, from: readonly string[], to: string): BookMetadata {
  const wanted = new Set(field === "tags" ? from.map((f) => f.toLowerCase()) : from);
  return REPLACERS[field](meta, (v) => wanted.has(field === "tags" ? v.toLowerCase() : v), to);
}

/** The values of a cleanup field, for telling whether a replacement changed anything. */
function fieldValue(m: BookMetadata, field: CleanupField): unknown {
  return { authors: m.authors, tags: m.tags, series: m.series, publishers: m.publisher }[field];
}

/** Write changed metadata, rename the files of the books on disk when their names change, and report. */
function applyChanges(deps: Deps, changes: readonly { id: number; next: BookMetadata }[], renameFiles: boolean): NameMergeResult {
  const { db, library, events } = deps;
  for (const { id, next } of changes) bookRepo.updateMetadata(db, id, next, null);
  const ids = changes.map((c) => c.id);
  const renames = renameFiles ? ids.filter((id) => library.index.hasBook(id)).map((id) => renameBookFiles(deps, id)) : [];
  if (ids.length) events.libraryChanged(ids);
  return { books: ids.length, renamed: renames.flatMap((r) => r.renamed), errors: renames.flatMap((r) => r.errors) };
}

/** Similar spellings grouped; lone authors too, so a single badly written name can be renamed. */
export async function groups(deps: Pick<AppContext, "db" | "library">, fieldRaw: unknown): Promise<NameGroupsDto> {
  const field = cleanupField(fieldRaw);
  await libraryReady(deps.library);
  const { groups, singles } = groupNames(libraryFacets(deps.library.index, deps.db)[field], field);
  return { field, groups, singles: field === "authors" ? singles : [] };
}

/**
 * Rename `from` to `to` on every book that has one of them (confirmed or not, on disk or not),
 * without changing whether a book is confirmed. Files are renamed when authors change.
 */
export async function merge(deps: Deps & Pick<AppContext, "aliases">, fieldRaw: unknown, fromRaw: unknown, toRaw: unknown): Promise<NameMergeResult> {
  const field = cleanupField(fieldRaw);
  if (!Array.isArray(fromRaw) || !fromRaw.length) throw new ValidationError("Choose at least one name to merge");
  const from = [...new Set(fromRaw.map((f) => name(f, "Name")))];
  const to = name(toRaw, "The new name");
  const { db, library, aliases } = deps;
  await libraryReady(library);

  return library.linker.exclusive(() => {
    const changes = bookRepo.idsWithName(db, field, from).flatMap((id) => {
      const book = bookRepo.get(db, id);
      if (!book) return [];
      const next = replaceName(book, field, from, to);
      return JSON.stringify(fieldValue(next, field)) === JSON.stringify(fieldValue(book, field)) ? [] : [{ id, next }];
    });
    const result = applyChanges(deps, changes, field === "authors");
    if (field === "tags") bookRepo.setTagSpelling(db, to);
    aliases.add(field, from, to);
    return result;
  });
}

/**
 * Authors matching a name, to merge into their spelling: Wikidata (curated, with library
 * authority records), else Open Library when Wikidata has no match or can't be reached.
 */
export async function searchAuthors(deps: Pick<AppContext, "http">, q: unknown, sourceRaw?: unknown): Promise<AuthorSearchDto> {
  // Both services search names in display order: "Tolkien, J. R. R." finds nothing.
  const query = displayOrder(name(q, "Search"));
  if (sourceRaw !== undefined && sourceRaw !== null && sourceRaw !== "wikidata" && sourceRaw !== "openlibrary") {
    throw new ValidationError("source must be wikidata or openlibrary");
  }
  const openLibrary = async (note: string | null): Promise<AuthorSearchDto> => ({
    source: "openlibrary",
    matches: await openLibraryAuthorSearch(deps.http, query),
    note,
  });
  if (sourceRaw === "openlibrary") return openLibrary(null);
  try {
    const matches = await wikidataAuthorSearch(deps.http, query);
    return matches.length ? { source: "wikidata", matches, note: null } : openLibrary(`No person called “${query}” on Wikidata.`);
  } catch (err) {
    return openLibrary(`Wikidata could not be reached (${errorMessage(err)}).`);
  }
}

/** Books on disk with this author, tag (any case), series or publisher, by title; as counted in `groups`. */
export async function booksWithName(deps: Pick<AppContext, "db" | "library">, fieldRaw: unknown, nameRaw: unknown): Promise<BookRefDto[]> {
  const field = cleanupField(fieldRaw);
  const n = name(nameRaw, "Name");
  const { db, library } = deps;
  await libraryReady(library);
  const ids = bookRepo.idsWithName(db, field, [n]).filter((id) => library.index.hasBook(id));
  return [...bookRepo.getMany(db, ids).values()]
    .map((b) => ({ id: b.id, title: b.title, authors: b.authors }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

/** Unconfirmed books on disk whose title and authors look swapped, with a suggested fix. */
export async function swapSuspects(deps: Pick<AppContext, "db" | "library">): Promise<SwapSuspectDto[]> {
  const { db, library } = deps;
  await libraryReady(library);
  const records = bookRepo.getMany(db, library.index.bookIds());
  return [...records.values()]
    .filter((b) => b.confirmedSource === null)
    .flatMap((b) => {
      const files = library.index.filesOfBook(b.id).map((f) => f.relPath);
      // The book's own (possibly wrong) authors must not vouch for themselves.
      const isKnownAuthor = (n: string) => bookRepo.hasAuthor(db, n, b.id);
      const suspect = swapSuspect({ id: b.id, title: b.title, authors: b.authors, files }, (f) => parseFilename(f, { isKnownAuthor }), isKnownAuthor);
      return suspect ? [suspect] : [];
    })
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

/**
 * Set the title and authors of books (the fixes chosen from `swapSuspects`, possibly edited),
 * renaming their files. Whether a book is confirmed doesn't change.
 */
export async function fixTitleAuthor(deps: Deps, itemsRaw: unknown): Promise<NameMergeResult> {
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw new ValidationError("Choose at least one book");
  const items = itemsRaw.map(titleAuthorFix);
  const { db, library } = deps;
  await libraryReady(library);

  return library.linker.exclusive(() => {
    const changes = items.flatMap(({ id, title, authors }) => {
      const book = bookRepo.get(db, id);
      if (!book || (book.title === title && JSON.stringify(book.authors) === JSON.stringify(authors))) return [];
      return [{ id, next: { ...book, title, authors } }];
    });
    return applyChanges(deps, changes, true);
  });
}

export function listAliases(deps: Pick<AppContext, "aliases">): AliasDto[] {
  return deps.aliases.list();
}

export function removeAlias(deps: Pick<AppContext, "aliases">, fieldRaw: unknown, variant: unknown): void {
  deps.aliases.remove(cleanupField(fieldRaw), name(variant, "Variant"));
}

function titleAuthorFix(v: unknown): TitleAuthorFix {
  const item = (v ?? {}) as { id?: unknown; title?: unknown; authors?: unknown };
  if (typeof item.id !== "number" || !Number.isInteger(item.id)) throw new ValidationError("Each book needs an id");
  if (!Array.isArray(item.authors)) throw new ValidationError("authors must be a list");
  return {
    id: item.id,
    title: name(item.title, "The title"),
    authors: uniqueCaseless(item.authors.map((a) => name(a, "An author"))),
  };
}
