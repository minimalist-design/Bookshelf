/** Book-level operations: edit, normalize filenames, merge, detach, move, delete, cover, file access. */
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app.ts";
import { uniqueCaseless } from "../collections.ts";
import * as coverStore from "../covers/store.ts";
import * as bookRepo from "../db/repo/books.ts";
import type { BookRecord, ConfirmedSource } from "../db/repo/books.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import { yearFrom } from "../extract/merge.ts";
import { normalizeDate } from "../extract/text.ts";
import type { IndexedFile } from "../library/libraryIndex.ts";
import { validateShelfName, ValidationError } from "../library/paths.ts";
import { toDetail } from "../library/queries.ts";
import type { BookMetadata } from "../metadata/types.ts";
import { toDisplayName } from "../naming/authors.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { detectFormat } from "../naming/formats.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import type { BookActionResult, BookDetailDto, BookUpdate, BulkRenameResult, DeleteResult, MoveResult } from "../../shared/types.ts";
import { ConflictError, NotFoundError } from "../api/http.ts";
import { eachSettled, relocateIndexedFile } from "./fileOps.ts";
import { renameBookFiles } from "./renameService.ts";

type Deps = Pick<AppContext, "db" | "library" | "config" | "events">;

export interface UpdateOptions {
  /** Source that confirms the metadata (default: manual edit). */
  confirm?: ConfirmedSource;
  olEditionKey?: string | null;
  olWorkKey?: string | null;
}

const MAX_TEXT = 200;
const MAX_LONG_TEXT = 50_000;

/** The on-disk file `hash` of book `bookId` (404 unless both exist and belong together). */
export function fileOf(deps: Pick<AppContext, "library">, bookId: number, hash: string): { abs: string; file: IndexedFile } {
  const file = deps.library.index.filesOfBook(bookId).find((f) => f.hash === hash);
  const root = deps.library.rootPath;
  if (!file || !root) throw new NotFoundError("File not found");
  return { abs: join(root, file.relPath), file };
}

/** Books are only addressable while at least one of their files is on disk. */
function requireVisible(deps: Pick<AppContext, "db" | "library">, id: number): BookRecord {
  const book = deps.library.index.hasBook(id) ? bookRepo.get(deps.db, id) : null;
  if (!book) throw new NotFoundError(`Book ${id} not found`);
  return book;
}

function detail(deps: Pick<AppContext, "db" | "library">, id: number): BookDetailDto {
  return toDetail(bookRepo.get(deps.db, id)!, deps.library.index.filesOfBook(id));
}

/** Whether a change of metadata changes the book's filenames. */
export function namesChange(current: BookMetadata, next: BookMetadata): boolean {
  return (
    next.title !== current.title ||
    next.authors.join("\u0000") !== current.authors.join("\u0000") ||
    next.isbn13 !== current.isbn13 ||
    next.doi !== current.doi
  );
}

/** Two rows sharing an ISBN/DOI would make file linking ambiguous: suggest merging instead. */
function assertIdentifiersFree(db: AppContext["db"], id: number, isbn13: string | null, doi: string | null): void {
  const other = bookRepo.bookIdsByIdentifiers(db, isbn13, doi).find((o) => o !== id);
  if (other === undefined) return;
  const book = bookRepo.get(db, other)!;
  throw new ConflictError(`"${book.title}" already has this ${isbn13 && book.isbn13 === isbn13 ? "ISBN" : "DOI"}; merge the books instead`, {
    bookId: book.id,
  });
}

/**
 * Manual edit: always confirms the metadata (kept if the files disappear).
 * Title, author or identifier changes rename the book's files.
 */
export async function update(deps: Deps, id: number, patch: BookUpdate, opts: UpdateOptions = {}): Promise<BookActionResult> {
  const { db, library, events } = deps;
  return library.linker.exclusive(() => {
    const current = requireVisible(deps, id);
    const next = applyPatch(current, patch);
    assertIdentifiersFree(db, id, next.isbn13, next.doi);

    bookRepo.updateMetadata(db, id, next, null);
    bookRepo.updateExtras(db, id, {
      rating: patch.rating === undefined ? undefined : validateRating(patch.rating),
      notes: patch.notes === undefined ? undefined : optionalText(patch.notes, "Notes", MAX_LONG_TEXT),
    });
    bookRepo.confirm(db, id, opts.confirm ?? "manual");
    if (opts.olEditionKey !== undefined || opts.olWorkKey !== undefined) {
      bookRepo.setOpenLibraryKeys(db, id, opts.olEditionKey ?? null, opts.olWorkKey ?? null);
    }
    const renamed = namesChange(current, next) ? renameBookFiles(deps, id) : { renamed: [], errors: [] };
    events.libraryChanged([id]);
    return { book: detail(deps, id), ...renamed };
  });
}

/** Rename files to the library pattern without changing (or confirming) metadata. */
export async function normalizeFilenames(deps: Deps, ids: readonly number[]): Promise<BulkRenameResult> {
  const { library, events } = deps;
  return library.linker.exclusive(() => {
    const results = ids.filter((id) => library.index.hasBook(id)).map((id) => renameBookFiles(deps, id));
    events.libraryChanged(ids);
    return { renamed: results.flatMap((r) => r.renamed), errors: results.flatMap((r) => r.errors) };
  });
}

/**
 * Merge `sourceId` into `targetId` (e.g. two formats of a book without identifiers).
 * The target keeps its metadata, filling empty fields from the source; the source row is
 * removed; its files take the target's names. Refused when both have the same format.
 */
export async function merge(deps: Deps, sourceId: number, targetId: number): Promise<BookActionResult> {
  if (sourceId === targetId) throw new ValidationError("Cannot merge a book into itself");
  const { db, library, events } = deps;
  const coversDir = deps.config.coversDir;
  return library.linker.exclusive(() => {
    const source = requireVisible(deps, sourceId);
    const target = requireVisible(deps, targetId);
    const targetFormats = new Set(library.index.filesOfBook(targetId).map((f) => f.format));
    const clash = library.index.filesOfBook(sourceId).find((f) => targetFormats.has(f.format));
    if (clash) throw new ConflictError(`Both books have a ${clash.format.toUpperCase()} file; a book can hold one file per format`);

    bookRepo.updateMetadata(db, targetId, fillEmpty(target, source), null);
    bookRepo.updateExtras(db, targetId, {
      rating: target.rating ?? source.rating,
      notes: [target.notes, source.notes].filter(Boolean).join("\n\n") || null,
    });
    bookRepo.moveHashes(db, sourceId, targetId);
    for (const f of library.index.filesOfBook(sourceId)) library.index.set({ ...f, bookId: targetId });
    if (!target.hasCover && source.hasCover) {
      // Adopt the source's cover by re-saving its files under the target id.
      coverStore.adopt(coversDir, sourceId, targetId);
      bookRepo.setHasCover(db, targetId, true, source.coverSource);
    }
    bookRepo.remove(db, sourceId);
    coverStore.remove(coversDir, sourceId);
    bookRepo.confirm(db, targetId, "manual");
    const renamed = renameBookFiles(deps, targetId);
    events.libraryChanged([sourceId, targetId]);
    return { book: detail(deps, targetId), ...renamed };
  });
}

/**
 * Split one file off into its own (unconfirmed) book with metadata freshly read from it.
 * The new row is created directly: it must not re-attach by identifier.
 */
export async function detach(deps: Deps & Pick<AppContext, "extract">, bookId: number, hash: string): Promise<BookActionResult> {
  const { db, library, events, extract } = deps;
  requireVisible(deps, bookId);
  const files = library.index.filesOfBook(bookId);
  const file = files.find((f) => f.hash === hash);
  if (!file) throw new NotFoundError("File not found in this book");
  if (files.length < 2) throw new ValidationError("The book has only this file");

  const detected = detectFormat(file.filename)!;
  const embedded = await extract(join(library.rootPath!, file.relPath), detected.format);
  const merged = library.linker.merge(embedded, library.linker.parse(file.filename), detected.stem);

  const newId = await library.linker.exclusive(() => {
    const current = library.index.get(file.relPath);
    if (!current || current.bookId !== bookId) throw new ConflictError("The file changed meanwhile; try again");
    const id = bookRepo.create(db, merged.metadata, merged.source);
    bookRepo.addHash(db, hash, id, detected.format);
    library.index.set({ ...current, bookId: id });
    return id;
  });
  const image = embedded.loadCover ? await embedded.loadCover().catch(() => null) : null;
  if (image && (await coverStore.save(deps.config.coversDir, newId, image))) bookRepo.setHasCover(db, newId, true, "embedded");
  events.libraryChanged([bookId, newId]);
  return { book: detail(deps, newId), renamed: [], errors: [] };
}

/**
 * Move every on-disk file of the given books to the top level of `shelf` (null = Unshelved).
 * Files already on that shelf stay where they are.
 */
export async function move(deps: Deps, ids: readonly number[], shelf: string | null): Promise<MoveResult> {
  const { db, library, events } = deps;
  return library.linker.exclusive(() => {
    const root = library.rootPath;
    if (!root) throw new ValidationError("No library directory is configured");
    const target = shelf === null || shelf === "" ? null : validateShelfName(shelf);
    if (target !== null && !isDirectory(join(root, target))) throw new NotFoundError(`Bookshelf not found: ${target}`);
    const files = ids.flatMap((id) => library.index.filesOfBook(id)).filter((f) => f.shelf !== target);
    const { done, errors } = eachSettled(
      files,
      (f) => f.relPath,
      (f) => relocateIndexedFile(root, library.index, db, f, target ?? ""),
    );
    events.libraryChanged(ids);
    return { moved: done, errors };
  });
}

/** Permanently delete all files of the given books (retention rule applies immediately). */
export async function remove(deps: Deps, ids: readonly number[]): Promise<DeleteResult> {
  return deleteFiles(deps, ids.flatMap((id) => deps.library.index.filesOfBook(id).map((f) => f.relPath)));
}

/** Permanently delete one file of a book. */
export async function removeFile(deps: Deps, bookId: number, hash: string): Promise<DeleteResult> {
  requireVisible(deps, bookId);
  const file = deps.library.index.filesOfBook(bookId).find((f) => f.hash === hash);
  if (!file) throw new NotFoundError("File not found in this book");
  return deleteFiles(deps, [file.relPath]);
}

/** Delete a file; one that is already gone counts as deleted. */
function rmIfPresent(path: string): void {
  try {
    rmSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function deleteFiles(deps: Deps, relPaths: readonly string[]): Promise<DeleteResult> {
  const { db, library, events } = deps;
  return library.linker.exclusive(() => {
    const root = library.rootPath!;
    const files = [...new Set(relPaths)].map((rel) => library.index.get(rel)).filter((f): f is IndexedFile => !!f);
    const { done: deleted, errors } = eachSettled(
      files,
      (f) => f.relPath,
      (f) => {
        rmIfPresent(join(root, f.relPath));
        library.index.remove(f.relPath);
        hashCacheRepo.remove(db, join(root, f.relPath));
        return f;
      },
    );
    const touched = new Set(deleted.map((f) => f.bookId));
    const gone = [...touched].filter((id) => !library.index.hasBook(id));
    const removedMetadata = library.retention.evaluate(gone);
    events.libraryChanged(touched);
    return {
      deletedFiles: deleted.map((f) => f.relPath),
      keptMetadata: gone.filter((id) => !removedMetadata.includes(id)),
      removedMetadata,
      errors,
    };
  });
}

/** Replace the cover with an uploaded image (a manual edit: confirms the metadata). */
export async function setCover(deps: Deps, id: number, data: Uint8Array): Promise<void> {
  requireVisible(deps, id);
  if (!(await coverStore.save(deps.config.coversDir, id, { data, mime: "application/octet-stream" }))) {
    throw new ValidationError("The image could not be read");
  }
  bookRepo.setHasCover(deps.db, id, true, "upload");
  bookRepo.confirm(deps.db, id, "manual");
  deps.events.libraryChanged([id]);
}

export async function removeCover(deps: Deps, id: number): Promise<void> {
  requireVisible(deps, id);
  coverStore.remove(deps.config.coversDir, id);
  bookRepo.setHasCover(deps.db, id, false, null);
  bookRepo.confirm(deps.db, id, "manual");
  deps.events.libraryChanged([id]);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---- validation -------------------------------------------------------------------

function optionalText(v: unknown, field: string, max = MAX_TEXT): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new ValidationError(`${field} must be text`);
  const t = max === MAX_TEXT ? v.replace(/\s+/g, " ").trim() : v.trim();
  if (t.length > max) throw new ValidationError(`${field} is too long`);
  return t || null;
}

function optionalNumber(v: unknown, field: string, { integer = false, min = 0 } = {}): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new ValidationError(`Invalid ${field}`);
  return n;
}

function validateRating(v: unknown): number | null {
  const n = optionalNumber(v, "rating", { integer: true });
  if (n !== null && n > 5) throw new ValidationError("Rating must be between 0 and 5");
  return n;
}

function stringList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ValidationError(`${field} must be a list of text`);
  const items = (v as string[]).map((raw) => raw.replace(/\s+/g, " ").trim()).filter(Boolean);
  const tooLong = items.find((t) => t.length > MAX_TEXT);
  if (tooLong) throw new ValidationError(`${field}: "${tooLong.slice(0, 20)}…" is too long`);
  return uniqueCaseless(items);
}

/** Apply a client patch on top of the current record, validating and normalizing every field. */
export function applyPatch(current: BookRecord, p: BookUpdate): BookMetadata {
  const has = (k: keyof BookUpdate) => Object.hasOwn(p, k);
  /** The patched value of a field (validated and normalized), else the current one. Fields are checked in form order. */
  const field = <K extends keyof BookMetadata & keyof BookUpdate>(k: K, parse: (v: unknown) => BookMetadata[K]): BookMetadata[K] =>
    has(k) ? parse(p[k]) : current[k];
  const identifier = (label: string, normalize: (raw: string) => string | null, invalid: string) => (v: unknown) => {
    const raw = optionalText(v, label);
    const value = raw === null ? null : normalize(raw);
    if (raw !== null && !value) throw new ValidationError(invalid);
    return value;
  };

  const title = field("title", (v) => {
    const t = optionalText(v, "Title");
    if (!t) throw new ValidationError("Title is required");
    return t;
  });
  const subtitle = field("subtitle", (v) => optionalText(v, "Subtitle"));
  // Each entry is one author; "Last, First" is turned into display order.
  const authors = field("authors", (v) => [...new Set(stringList(v, "Authors").map(toDisplayName))]);
  const isbn13 = field("isbn13", identifier("ISBN", normalizeIsbn, "Not a valid ISBN-10 or ISBN-13"));
  const doi = field("doi", identifier("DOI", normalizeDoi, "Not a valid DOI (expected 10.xxxx/…)"));
  const publisher = field("publisher", (v) => optionalText(v, "Publisher"));
  const edition = field("edition", (v) => optionalText(v, "Edition"));
  const publishedDate = field("publishedDate", identifier("Published date", normalizeDate, "Published date must look like YYYY, YYYY-MM or YYYY-MM-DD"));
  const language = field("language", (v) => optionalText(v, "Language")?.toLowerCase() ?? null);
  const pages = field("pages", (v) => optionalNumber(v, "page count", { integer: true, min: 1 }));
  const description = field("description", (v) => optionalText(v, "Description", MAX_LONG_TEXT));
  const series = field("series", (v) => optionalText(v, "Series"));
  const seriesIndex = field("seriesIndex", (v) => optionalNumber(v, "series number"));
  const tags = field("tags", (v) => stringList(v, "Tags"));
  return {
    title,
    subtitle,
    authors,
    isbn13,
    doi,
    publisher,
    edition,
    publishedDate,
    year: has("publishedDate") ? yearFrom(publishedDate) : current.year,
    language,
    pages,
    description,
    series,
    seriesIndex: series ? seriesIndex : null,
    tags,
  };
}

/** Target wins; empty target fields are filled from the source. */
function fillEmpty(target: BookRecord, source: BookRecord): BookMetadata {
  const pick = <T>(a: T, b: T): T => (a === null || a === undefined || a === "" || (Array.isArray(a) && a.length === 0) ? b : a);
  return {
    title: target.title,
    subtitle: pick(target.subtitle, source.subtitle),
    authors: pick(target.authors, source.authors),
    isbn13: pick(target.isbn13, source.isbn13),
    doi: pick(target.doi, source.doi),
    publisher: pick(target.publisher, source.publisher),
    edition: pick(target.edition, source.edition),
    publishedDate: pick(target.publishedDate, source.publishedDate),
    year: pick(target.year, source.year),
    language: pick(target.language, source.language),
    pages: pick(target.pages, source.pages),
    description: pick(target.description, source.description),
    series: pick(target.series, source.series),
    seriesIndex: target.series ? target.seriesIndex : source.seriesIndex,
    tags: [...new Set([...target.tags, ...source.tags])],
  };
}
