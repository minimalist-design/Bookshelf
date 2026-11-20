import { dedupeCaseless, displayOrder, groupNames } from "../cleanup/similarity.ts";
import { swapSuspect } from "../cleanup/swaps.ts";
import type { AliasesRepo } from "../db/repo/aliases.ts";
import type { BooksRepo } from "../db/repo/books.ts";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Library } from "../library/library.ts";
import { ValidationError } from "../library/paths.ts";
import { libraryFacets } from "../library/queries.ts";
import { parseFilename } from "../naming/parseFilename.ts";
import type { BookMetadata } from "../metadata/types.ts";
import type { HttpClient } from "../sources/http.ts";
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
import { libraryReady } from "./maintenanceService.ts";
import { renameBookFiles } from "./renameService.ts";

export interface CleanupDeps {
  library: Library;
  books: BooksRepo;
  hashCache: HashCacheRepo;
  aliases: AliasesRepo;
  http: HttpClient;
  events: EventBus;
}

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

/** `meta` with every `from` name of `field` replaced by `to` (tags compare without case, as they are stored). */
export function replaceName(meta: BookMetadata, field: CleanupField, from: readonly string[], to: string): BookMetadata {
  const wanted = new Set(field === "tags" ? from.map((f) => f.toLowerCase()) : from);
  const hit = (v: string) => wanted.has(field === "tags" ? v.toLowerCase() : v);
  const list = (l: readonly string[]) => dedupeCaseless(l.map((v) => (hit(v) ? to : v)));
  switch (field) {
    case "authors":
      return { ...meta, authors: list(meta.authors) };
    case "tags":
      return { ...meta, tags: list(meta.tags) };
    case "series":
      return meta.series !== null && hit(meta.series) ? { ...meta, series: to } : meta;
    case "publishers":
      return meta.publisher !== null && hit(meta.publisher) ? { ...meta, publisher: to } : meta;
  }
}

/** Merging spelling variants of names into one, and remembering them as aliases. */
export class CleanupService {
  constructor(private readonly deps: CleanupDeps) {}

  /** Similar spellings grouped; lone authors too, so a single badly written name can be renamed. */
  async groups(fieldRaw: unknown): Promise<NameGroupsDto> {
    const field = cleanupField(fieldRaw);
    await libraryReady(this.deps.library);
    const facets = libraryFacets(this.deps.library.index, this.deps.books)[field];
    const { groups, singles } = groupNames(facets, field);
    return { field, groups, singles: field === "authors" ? singles : [] };
  }

  /**
   * Rename `from` to `to` on every book that has one of them (confirmed or not, on disk or not),
   * without changing whether a book is confirmed. Files are renamed when authors change.
   */
  async merge(fieldRaw: unknown, fromRaw: unknown, toRaw: unknown): Promise<NameMergeResult> {
    const field = cleanupField(fieldRaw);
    if (!Array.isArray(fromRaw) || !fromRaw.length) throw new ValidationError("Choose at least one name to merge");
    const from = [...new Set(fromRaw.map((f) => name(f, "Name")))];
    const to = name(toRaw, "The new name");
    const { library, books, aliases, events } = this.deps;
    await libraryReady(library);

    return library.linker.exclusive(() => {
      const changed = books.idsWithName(field, from).flatMap((id) => {
        const book = books.get(id);
        if (!book) return [];
        const next = replaceName(book, field, from, to);
        if (JSON.stringify(pick(next, field)) === JSON.stringify(pick(book, field))) return [];
        books.updateMetadata(id, next, null);
        return [id];
      });
      if (field === "tags") books.setTagSpelling(to);
      aliases.add(field, from, to);

      const renames = field === "authors" ? changed.filter((id) => library.index.hasBook(id)).map((id) => renameBookFiles(this.deps, id)) : [];
      if (changed.length) events.libraryChanged(changed);
      return {
        books: changed.length,
        renamed: renames.flatMap((r) => r.renamed),
        errors: renames.flatMap((r) => r.errors),
      };
    });
  }

  /**
   * Authors matching a name, to merge into their spelling: Wikidata (curated, with library
   * authority records), else Open Library when Wikidata has no match or can't be reached.
   */
  async searchAuthors(q: unknown, sourceRaw?: unknown): Promise<AuthorSearchDto> {
    // Both services search names in display order: "Tolkien, J. R. R." finds nothing.
    const query = displayOrder(name(q, "Search"));
    if (sourceRaw !== undefined && sourceRaw !== null && sourceRaw !== "wikidata" && sourceRaw !== "openlibrary") {
      throw new ValidationError("source must be wikidata or openlibrary");
    }
    const openLibrary = async (note: string | null): Promise<AuthorSearchDto> => ({
      source: "openlibrary",
      matches: await openLibraryAuthorSearch(this.deps.http, query),
      note,
    });
    if (sourceRaw === "openlibrary") return openLibrary(null);
    try {
      const matches = await wikidataAuthorSearch(this.deps.http, query);
      return matches.length ? { source: "wikidata", matches, note: null } : openLibrary(`No person called “${query}” on Wikidata.`);
    } catch (err) {
      return openLibrary(`Wikidata could not be reached (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  /** Books on disk with this author, tag (any case), series or publisher, by title; as counted in `groups`. */
  async booksWithName(fieldRaw: unknown, nameRaw: unknown): Promise<BookRefDto[]> {
    const field = cleanupField(fieldRaw);
    const n = name(nameRaw, "Name");
    const { library, books } = this.deps;
    await libraryReady(library);
    const ids = books.idsWithName(field, [n]).filter((id) => library.index.hasBook(id));
    return [...books.getMany(ids).values()]
      .map((b) => ({ id: b.id, title: b.title, authors: b.authors }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Unconfirmed books on disk whose title and authors look swapped, with a suggested fix. */
  async swapSuspects(): Promise<SwapSuspectDto[]> {
    const { library, books } = this.deps;
    await libraryReady(library);
    const records = books.getMany(library.index.bookIds());
    return [...records.values()]
      .filter((b) => b.confirmedSource === null)
      .flatMap((b) => {
        const files = library.index.filesOfBook(b.id).map((f) => f.relPath);
        // The book's own (possibly wrong) authors must not vouch for themselves.
        const isKnownAuthor = (n: string) => books.hasAuthor(n, b.id);
        const suspect = swapSuspect(
          { id: b.id, title: b.title, authors: b.authors, files },
          (f) => parseFilename(f, { isKnownAuthor }),
          isKnownAuthor,
        );
        return suspect ? [suspect] : [];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Set the title and authors of books (the fixes chosen from `swapSuspects`, possibly edited),
   * renaming their files. Whether a book is confirmed doesn't change.
   */
  async fixTitleAuthor(itemsRaw: unknown): Promise<NameMergeResult> {
    if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw new ValidationError("Choose at least one book");
    const items = itemsRaw.map(titleAuthorFix);
    const { library, books, events } = this.deps;
    await libraryReady(library);

    return library.linker.exclusive(() => {
      const changed = items.flatMap(({ id, title, authors }) => {
        const book = books.get(id);
        if (!book) return [];
        if (book.title === title && JSON.stringify(book.authors) === JSON.stringify(authors)) return [];
        books.updateMetadata(id, { ...book, title, authors }, null);
        return [id];
      });
      const renames = changed.filter((id) => library.index.hasBook(id)).map((id) => renameBookFiles(this.deps, id));
      if (changed.length) events.libraryChanged(changed);
      return {
        books: changed.length,
        renamed: renames.flatMap((r) => r.renamed),
        errors: renames.flatMap((r) => r.errors),
      };
    });
  }

  aliases(): AliasDto[] {
    return this.deps.aliases.list();
  }

  removeAlias(fieldRaw: unknown, variant: unknown): void {
    this.deps.aliases.remove(cleanupField(fieldRaw), name(variant, "Variant"));
  }
}

function titleAuthorFix(v: unknown): TitleAuthorFix {
  const item = (v ?? {}) as { id?: unknown; title?: unknown; authors?: unknown };
  if (typeof item.id !== "number" || !Number.isInteger(item.id)) throw new ValidationError("Each book needs an id");
  if (!Array.isArray(item.authors)) throw new ValidationError("authors must be a list");
  return {
    id: item.id,
    title: name(item.title, "The title"),
    authors: dedupeCaseless(item.authors.map((a) => name(a, "An author"))),
  };
}

function pick(m: BookMetadata, field: CleanupField): unknown {
  return { authors: m.authors, tags: m.tags, series: m.series, publishers: m.publisher }[field];
}
