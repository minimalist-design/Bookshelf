import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CoverStore } from "../covers/store.ts";
import type { BookRecord, BooksRepo, ConfirmedSource } from "../db/repo/books.ts";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Extractor } from "../extract/index.ts";
import { mergeMetadata, yearFrom } from "../extract/merge.ts";
import { normalizeDate } from "../extract/text.ts";
import type { Library } from "../library/library.ts";
import { validateShelfName, ValidationError } from "../library/paths.ts";
import { toDetail } from "../library/queries.ts";
import type { BookMetadata } from "../metadata/types.ts";
import { toDisplayName } from "../naming/authors.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { detectFormat } from "../naming/formats.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { parseFilename } from "../naming/parseFilename.ts";
import type { BookActionResult, BookUpdate, BulkRenameResult, DeleteResult, MoveResult } from "../../shared/types.ts";
import { ConflictError, NotFoundError } from "../api/http.ts";
import { relocateIndexedFile } from "./fileOps.ts";
import { renameBookFiles } from "./renameService.ts";

export interface BookServiceDeps {
  library: Library;
  books: BooksRepo;
  hashCache: HashCacheRepo;
  covers: CoverStore;
  extract: Extractor;
  events: EventBus;
}

export interface UpdateOptions {
  /** Source that confirms the metadata (default: manual edit). */
  confirm?: ConfirmedSource;
  olEditionKey?: string | null;
  olWorkKey?: string | null;
}

const MAX_TEXT = 200;
const MAX_LONG_TEXT = 50_000;

/** Book-level operations initiated by the user: edit, normalize filenames, merge, detach, cover. */
export class BookService {
  constructor(private readonly deps: BookServiceDeps) {}

  /** Books are only addressable while at least one of their files is on disk. */
  private requireVisible(id: number): BookRecord {
    const book = this.deps.library.index.hasBook(id) ? this.deps.books.get(id) : null;
    if (!book) throw new NotFoundError(`Book ${id} not found`);
    return book;
  }

  private detail(id: number) {
    const book = this.deps.books.get(id)!;
    return toDetail(book, this.deps.library.index.filesOfBook(id));
  }

  /**
   * Manual edit: always confirms the metadata (kept if the files disappear).
   * Title, author or identifier changes rename the book's files.
   */
  async update(id: number, patch: BookUpdate, opts: UpdateOptions = {}): Promise<BookActionResult> {
    const { library, books, events } = this.deps;
    return library.linker.exclusive(() => {
      const current = this.requireVisible(id);
      const next = applyPatch(current, patch);
      this.assertIdentifiersFree(id, next.isbn13, next.doi);

      books.updateMetadata(id, next, null);
      books.updateExtras(id, {
        rating: patch.rating === undefined ? undefined : validateRating(patch.rating),
        notes: patch.notes === undefined ? undefined : optionalText(patch.notes, "Notes", MAX_LONG_TEXT),
      });
      books.confirm(id, opts.confirm ?? "manual");
      if (opts.olEditionKey !== undefined || opts.olWorkKey !== undefined) {
        books.setOpenLibraryKeys(id, opts.olEditionKey ?? null, opts.olWorkKey ?? null);
      }

      const nameChanged =
        next.title !== current.title ||
        next.authors.join("\u0000") !== current.authors.join("\u0000") ||
        next.isbn13 !== current.isbn13 ||
        next.doi !== current.doi;
      const renamed = nameChanged ? renameBookFiles(this.deps, id) : { renamed: [], errors: [] };
      events.libraryChanged([id]);
      return { book: this.detail(id), ...renamed };
    });
  }

  /** Rename files to the library pattern without changing (or confirming) metadata. */
  async normalizeFilenames(ids: number[]): Promise<BulkRenameResult> {
    const { library, events } = this.deps;
    return library.linker.exclusive(() => {
      const out: BulkRenameResult = { renamed: [], errors: [] };
      for (const id of ids) {
        if (!library.index.hasBook(id)) continue;
        const r = renameBookFiles(this.deps, id);
        out.renamed.push(...r.renamed);
        out.errors.push(...r.errors);
      }
      events.libraryChanged(ids);
      return out;
    });
  }

  /**
   * Merge `sourceId` into `targetId` (e.g. two formats of a book without identifiers).
   * The target keeps its metadata, filling empty fields from the source; the source row is
   * removed; its files take the target's names. Refused when both have the same format.
   */
  async merge(sourceId: number, targetId: number): Promise<BookActionResult> {
    if (sourceId === targetId) throw new ValidationError("Cannot merge a book into itself");
    const { library, books, covers, events } = this.deps;
    return library.linker.exclusive(() => {
      const source = this.requireVisible(sourceId);
      const target = this.requireVisible(targetId);
      const targetFormats = new Set(library.index.filesOfBook(targetId).map((f) => f.format));
      const clash = library.index.filesOfBook(sourceId).find((f) => targetFormats.has(f.format));
      if (clash) {
        throw new ConflictError(`Both books have a ${clash.format.toUpperCase()} file; a book can hold one file per format`);
      }

      const filled = fillEmpty(target, source);
      books.updateMetadata(targetId, filled, null);
      books.updateExtras(targetId, {
        rating: target.rating ?? source.rating,
        notes: [target.notes, source.notes].filter(Boolean).join("\n\n") || null,
      });
      books.moveHashes(sourceId, targetId);
      for (const f of library.index.filesOfBook(sourceId)) library.index.set({ ...f, bookId: targetId });
      if (!target.hasCover && source.hasCover) {
        // Adopt the source's cover by re-saving its files under the target id.
        covers.adopt(sourceId, targetId);
        books.setHasCover(targetId, true, source.coverSource);
      }
      books.delete(sourceId);
      covers.remove(sourceId);
      books.confirm(targetId, "manual");
      const renamed = renameBookFiles(this.deps, targetId);
      events.libraryChanged([sourceId, targetId]);
      return { book: this.detail(targetId), ...renamed };
    });
  }

  /**
   * Split one file off into its own (unconfirmed) book with metadata freshly read from it.
   * The new row is created directly: it must not re-attach by identifier.
   */
  async detach(bookId: number, hash: string): Promise<BookActionResult> {
    const { library, books, covers, events, extract } = this.deps;
    this.requireVisible(bookId);
    const file = library.index.filesOfBook(bookId).find((f) => f.hash === hash);
    if (!file) throw new NotFoundError("File not found in this book");
    if (library.index.filesOfBook(bookId).length < 2) throw new ValidationError("The book has only this file");

    const abs = join(library.rootPath!, file.relPath);
    const detected = detectFormat(file.filename)!;
    const embedded = await extract(abs, detected.format);
    const merged = mergeMetadata(embedded, parseFilename(file.filename), detected.stem);

    const newId = await library.linker.exclusive(() => {
      const current = library.index.get(file.relPath);
      if (!current || current.bookId !== bookId) throw new ConflictError("The file changed meanwhile; try again");
      const id = books.create(merged.metadata, merged.source);
      books.addHash(hash, id, detected.format);
      library.index.set({ ...current, bookId: id });
      return id;
    });
    const image = embedded.loadCover ? await embedded.loadCover().catch(() => null) : null;
    if (image && (await covers.save(newId, image))) books.setHasCover(newId, true, "embedded");
    events.libraryChanged([bookId, newId]);
    return { book: this.detail(newId), renamed: [], errors: [] };
  }

  /**
   * Move every on-disk file of the given books to the top level of `shelf` (null = Unshelved).
   * Files already on that shelf stay where they are.
   */
  async move(ids: number[], shelf: string | null): Promise<MoveResult> {
    const { library, hashCache, events } = this.deps;
    return library.linker.exclusive(() => {
      const root = library.rootPath;
      if (!root) throw new ValidationError("No library directory is configured");
      const target = shelf === null || shelf === "" ? null : validateShelfName(shelf);
      if (target !== null && !isDirectory(join(root, target))) throw new NotFoundError(`Bookshelf not found: ${target}`);
      const out: MoveResult = { moved: [], errors: [] };
      for (const id of ids) {
        for (const file of library.index.filesOfBook(id)) {
          if (file.shelf === target) continue;
          try {
            out.moved.push(relocateIndexedFile(root, library.index, hashCache, file, target ?? ""));
          } catch (err) {
            out.errors.push(`${file.relPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      events.libraryChanged(ids);
      return out;
    });
  }

  /** Permanently delete all files of the given books (retention rule applies immediately). */
  async deleteBooks(ids: number[]): Promise<DeleteResult> {
    return this.deleteFiles(ids.flatMap((id) => this.deps.library.index.filesOfBook(id).map((f) => f.relPath)));
  }

  /** Permanently delete one file of a book. */
  async deleteFile(bookId: number, hash: string): Promise<DeleteResult> {
    this.requireVisible(bookId);
    const file = this.deps.library.index.filesOfBook(bookId).find((f) => f.hash === hash);
    if (!file) throw new NotFoundError("File not found in this book");
    return this.deleteFiles([file.relPath]);
  }

  private async deleteFiles(relPaths: string[]): Promise<DeleteResult> {
    const { library, hashCache, events } = this.deps;
    return library.linker.exclusive(() => {
      const root = library.rootPath!;
      const out: DeleteResult = { deletedFiles: [], keptMetadata: [], removedMetadata: [], errors: [] };
      const touched = new Set<number>();
      for (const rel of relPaths) {
        const file = library.index.get(rel);
        if (!file) continue;
        try {
          rmSync(join(root, rel));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            out.errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        library.index.remove(rel);
        hashCache.delete(join(root, rel));
        out.deletedFiles.push(rel);
        touched.add(file.bookId);
      }
      const gone = [...touched].filter((id) => !library.index.hasBook(id));
      out.removedMetadata = library.retention.evaluate(gone);
      out.keptMetadata = gone.filter((id) => !out.removedMetadata.includes(id));
      events.libraryChanged(touched);
      return out;
    });
  }

  /** Replace the cover with an uploaded image (a manual edit: confirms the metadata). */
  async setCover(id: number, data: Uint8Array): Promise<void> {
    this.requireVisible(id);
    if (!(await this.deps.covers.save(id, { data, mime: "application/octet-stream" }))) {
      throw new ValidationError("The image could not be read");
    }
    this.deps.books.setHasCover(id, true, "upload");
    this.deps.books.confirm(id, "manual");
    this.deps.events.libraryChanged([id]);
  }

  async removeCover(id: number): Promise<void> {
    this.requireVisible(id);
    this.deps.covers.remove(id);
    this.deps.books.setHasCover(id, false, null);
    this.deps.books.confirm(id, "manual");
    this.deps.events.libraryChanged([id]);
  }

  /** Two rows sharing an ISBN/DOI would make file linking ambiguous: suggest merging instead. */
  private assertIdentifiersFree(id: number, isbn13: string | null, doi: string | null): void {
    const others = this.deps.books.bookIdsByIdentifiers(isbn13, doi).filter((other) => other !== id);
    if (others.length) {
      const other = this.deps.books.get(others[0]!)!;
      throw new ConflictError(`"${other.title}" already has this ${isbn13 && other.isbn13 === isbn13 ? "ISBN" : "DOI"}; merge the books instead`, {
        bookId: other.id,
      });
    }
  }
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
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v as string[]) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length > MAX_TEXT) throw new ValidationError(`${field}: "${t.slice(0, 20)}…" is too long`);
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Apply a client patch on top of the current record, validating and normalizing every field. */
export function applyPatch(current: BookRecord, p: BookUpdate): BookMetadata {
  const has = (k: keyof BookUpdate) => Object.prototype.hasOwnProperty.call(p, k);
  const next: BookMetadata = {
    title: current.title,
    subtitle: current.subtitle,
    authors: current.authors,
    isbn13: current.isbn13,
    doi: current.doi,
    publisher: current.publisher,
    publishedDate: current.publishedDate,
    year: current.year,
    language: current.language,
    pages: current.pages,
    description: current.description,
    series: current.series,
    seriesIndex: current.seriesIndex,
    tags: current.tags,
  };
  if (has("title")) {
    const t = optionalText(p.title, "Title");
    if (!t) throw new ValidationError("Title is required");
    next.title = t;
  }
  if (has("subtitle")) next.subtitle = optionalText(p.subtitle, "Subtitle");
  if (has("authors")) {
    // Each entry is one author; "Last, First" is turned into display order.
    next.authors = [...new Set(stringList(p.authors, "Authors").map(toDisplayName))];
  }
  if (has("isbn13")) {
    const raw = optionalText(p.isbn13, "ISBN");
    next.isbn13 = raw === null ? null : normalizeIsbn(raw);
    if (raw !== null && !next.isbn13) throw new ValidationError("Not a valid ISBN-10 or ISBN-13");
  }
  if (has("doi")) {
    const raw = optionalText(p.doi, "DOI");
    next.doi = raw === null ? null : normalizeDoi(raw);
    if (raw !== null && !next.doi) throw new ValidationError("Not a valid DOI (expected 10.xxxx/…)");
  }
  if (has("publisher")) next.publisher = optionalText(p.publisher, "Publisher");
  if (has("publishedDate")) {
    const raw = optionalText(p.publishedDate, "Published date");
    next.publishedDate = raw === null ? null : normalizeDate(raw);
    if (raw !== null && !next.publishedDate) throw new ValidationError("Published date must look like YYYY, YYYY-MM or YYYY-MM-DD");
    next.year = yearFrom(next.publishedDate);
  }
  if (has("language")) next.language = optionalText(p.language, "Language")?.toLowerCase() ?? null;
  if (has("pages")) next.pages = optionalNumber(p.pages, "page count", { integer: true, min: 1 });
  if (has("description")) next.description = optionalText(p.description, "Description", MAX_LONG_TEXT);
  if (has("series")) next.series = optionalText(p.series, "Series");
  if (has("seriesIndex")) next.seriesIndex = optionalNumber(p.seriesIndex, "series number");
  if (!next.series) next.seriesIndex = null;
  if (has("tags")) next.tags = stringList(p.tags, "Tags");
  return next;
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
