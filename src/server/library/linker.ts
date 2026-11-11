import type { BooksRepo } from "../db/repo/books.ts";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { Extractor } from "../extract/index.ts";
import { FORMAT_METADATA_RANK, fillMetadata, mergeMetadata, type MergeResult } from "../extract/merge.ts";
import type { BookMetadata, RawMetadata } from "../metadata/types.ts";
import type { BookFormat, DetectedFormat } from "../naming/formats.ts";
import { parseFilename } from "../naming/parseFilename.ts";
import { hashFile } from "./hasher.ts";
import { shelfOf, type IndexedFile, type LibraryIndex } from "./libraryIndex.ts";

export interface FileToLink {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
  ino: number;
  detected: DetectedFormat;
  /** Already known content hash (e.g. a file the app just wrote, or a detected move). */
  hash?: string;
}

export type LinkOutcome = "hash" | "identifier" | "created";

export interface Decision {
  bookId: number;
  outcome: "identifier" | "created";
  preferred: boolean;
}

export interface LinkResult {
  file: IndexedFile;
  outcome: LinkOutcome;
}

export interface LinkedNewInfo {
  outcome: "identifier" | "created";
  /** This file's format is the best metadata source the book has on disk (its cover should win too). */
  preferred: boolean;
}

export interface LinkerDeps {
  books: BooksRepo;
  hashCache: HashCacheRepo;
  extract: Extractor;
  index: LibraryIndex;
  /**
   * Called after a file with previously unknown content was linked (new book, or attached by
   * identifier), with the embedded metadata that was read from it (e.g. to store its cover).
   */
  onLinkedNew?: (bookId: number, info: LinkedNewInfo, embedded: RawMetadata, file: FileToLink) => Promise<void> | void;
}

/**
 * Connects a file on disk to its metadata row:
 * 1. content hash → existing book;
 * 2. else isbn13/doi → existing book that has no on-disk file of this format (attach);
 * 3. else a new book from embedded metadata merged with the filename.
 * Decisions run one at a time so concurrent scans cannot create duplicate rows.
 */
export class Linker {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LinkerDeps) {}

  /** Run `fn` while holding the linking lock (all book-identity decisions are serialized). */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async hashOf(file: FileToLink): Promise<string> {
    if (file.hash) return file.hash;
    const { hashCache } = this.deps;
    const cached = hashCache.get(file.abs, file.size, file.mtimeMs);
    if (cached) return cached;
    const hash = await hashFile(file.abs);
    hashCache.put(file.abs, file.size, file.mtimeMs, hash);
    return hash;
  }

  async link(file: FileToLink): Promise<LinkResult> {
    const { books, index } = this.deps;
    const hash = await this.hashOf(file);
    if (file.hash) this.deps.hashCache.put(file.abs, file.size, file.mtimeMs, hash);

    const known = await this.exclusive(() => {
      const id = books.bookIdByHash(hash);
      return id === null ? null : this.register(file, hash, id);
    });
    if (known) return { file: known, outcome: "hash" };

    // Unknown content: read metadata outside the lock (slow I/O), decide inside it.
    const parsed = parseFilename(file.rel.slice(file.rel.lastIndexOf("/") + 1));
    let embedded: RawMetadata = {};
    try {
      embedded = await this.deps.extract(file.abs, file.detected.format);
    } catch (err) {
      console.warn(`Metadata extraction failed for ${file.rel}:`, err);
    }
    const merged = mergeMetadata(embedded, parsed, file.detected.stem);

    let preferred = true;
    const result = await this.exclusive(() => {
      const byHash = books.bookIdByHash(hash); // may have been linked meanwhile
      if (byHash !== null) return { file: this.register(file, hash, byHash), outcome: "hash" as const };
      const decision = this.attachOrCreate(hash, file.detected.format, merged, file.rel);
      preferred = decision.preferred;
      return { file: this.register(file, hash, decision.bookId), outcome: decision.outcome };
    });

    if (result.outcome !== "hash") await this.afterLinkedNew(result.file.bookId, { outcome: result.outcome, preferred }, embedded, file);
    return result;
  }

  /**
   * Must run inside `exclusive`. Attach unknown content to the first book with the same
   * isbn13/doi that has no on-disk file of this format, else create a new book.
   */
  attachOrCreate(hash: string, format: BookFormat, merged: MergeResult, exceptRel?: string): Decision {
    const { books, index } = this.deps;
    const { isbn13, doi } = merged.metadata;
    for (const candidate of books.bookIdsByIdentifiers(isbn13, doi)) {
      if (!index.bookHasFormat(candidate, format, exceptRel)) {
        books.addHash(hash, candidate, format);
        const preferred = this.remergeDerived(candidate, merged, format, exceptRel);
        return { bookId: candidate, outcome: "identifier", preferred };
      }
    }
    const id = books.create(merged.metadata, merged.source);
    books.addHash(hash, id, format);
    return { bookId: id, outcome: "created", preferred: true };
  }

  async afterLinkedNew(bookId: number, info: LinkedNewInfo, embedded: RawMetadata, file: FileToLink): Promise<void> {
    if (!this.deps.onLinkedNew) return;
    try {
      await this.deps.onLinkedNew(bookId, info, embedded, file);
    } catch (err) {
      console.warn(`Post-link step failed for ${file.rel}:`, err);
    }
  }

  /**
   * A file joined an existing book by identifier. Unconfirmed metadata is purely derived from
   * files, so it is recomputed: the better-ranked format wins per field, the other fills gaps.
   * Confirmed metadata (external source or manual edit) is never touched.
   * Returns whether the new file is now the book's preferred metadata source.
   */
  private remergeDerived(bookId: number, merged: MergeResult, format: BookFormat, exceptRel?: string): boolean {
    const { books, index } = this.deps;
    const existing = books.get(bookId);
    if (!existing) return false;
    const others = index.filesOfBook(bookId).filter((f) => f.relPath !== exceptRel);
    const bestOther = Math.min(...others.map((f) => FORMAT_METADATA_RANK[f.format]), Infinity);
    const preferred = FORMAT_METADATA_RANK[format] < bestOther;
    if (existing.confirmedSource !== null) return preferred;
    const current = pickMetadata(existing);
    const next = preferred ? fillMetadata(merged.metadata, current) : fillMetadata(current, merged.metadata);
    books.updateMetadata(bookId, pickMetadata(next), preferred ? merged.source : null);
    return preferred;
  }

  /** Put a linked file into the index (call inside `exclusive`). */
  register(file: FileToLink, hash: string, bookId: number): IndexedFile {
    const indexed: IndexedFile = {
      relPath: file.rel,
      filename: file.rel.slice(file.rel.lastIndexOf("/") + 1),
      shelf: shelfOf(file.rel),
      format: file.detected.format,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ino: file.ino,
      hash,
      bookId,
    };
    this.deps.index.set(indexed);
    return indexed;
  }
}

function pickMetadata(m: BookMetadata): BookMetadata {
  return {
    title: m.title,
    subtitle: m.subtitle,
    authors: m.authors,
    isbn13: m.isbn13,
    doi: m.doi,
    publisher: m.publisher,
    publishedDate: m.publishedDate,
    year: m.year,
    language: m.language,
    pages: m.pages,
    description: m.description,
    series: m.series,
    seriesIndex: m.seriesIndex,
    tags: m.tags,
  };
}
