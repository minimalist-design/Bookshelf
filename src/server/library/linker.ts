import type { Database } from "bun:sqlite";
import * as bookRepo from "../db/repo/books.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import type { Extractor } from "../extract/index.ts";
import { FORMAT_METADATA_RANK, fillMetadata, mergeMetadata, type MergeResult } from "../extract/merge.ts";
import { pickMetadata, type RawMetadata } from "../metadata/types.ts";
import type { BookFormat, DetectedFormat } from "../naming/formats.ts";
import { parseFilename, type ParsedFilename } from "../naming/parseFilename.ts";
import { hashFile } from "./hasher.ts";
import { shelfOf, type IndexedFile, type LibraryIndex } from "./libraryIndex.ts";

export interface FileToLink {
  readonly abs: string;
  readonly rel: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly detected: DetectedFormat;
  /** Already known content hash (e.g. a file the app just wrote, or a detected move). */
  readonly hash?: string;
}

export type LinkOutcome = "hash" | "identifier" | "created";

export interface Decision {
  readonly bookId: number;
  readonly outcome: "identifier" | "created";
  readonly preferred: boolean;
}

export interface LinkResult {
  readonly file: IndexedFile;
  readonly outcome: LinkOutcome;
}

export interface LinkedNewInfo {
  readonly outcome: "identifier" | "created";
  /** This file's format is the best metadata source the book has on disk (its cover should win too). */
  readonly preferred: boolean;
}

export interface LinkerDeps {
  db: Database;
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
export interface Linker {
  /** Run `fn` while holding the linking lock (all book-identity decisions are serialized). */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  /** A filename read in Bookshelf's own style (any other name is just a title). */
  parse(filename: string): ParsedFilename;
  /** Metadata of a file: embedded, else from its name. */
  merge(embedded: RawMetadata, parsed: ParsedFilename, fileStem: string): MergeResult;
  hashOf(file: FileToLink): Promise<string>;
  link(file: FileToLink): Promise<LinkResult>;
  /**
   * Must run inside `exclusive`. Attach unknown content to the first book with the same
   * isbn13/doi that has no on-disk file of this format, else create a new book.
   */
  attachOrCreate(hash: string, format: BookFormat, merged: MergeResult, exceptRel?: string): Decision;
  afterLinkedNew(bookId: number, info: LinkedNewInfo, embedded: RawMetadata, file: FileToLink): Promise<void>;
  /** Put a linked file into the index (call inside `exclusive`). */
  register(file: FileToLink, hash: string, bookId: number): IndexedFile;
}

/** The index entry for a linked file. */
export function toIndexedFile(file: FileToLink, hash: string, bookId: number): IndexedFile {
  return {
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
}

/** Whether a file of `format` is a better metadata source than every other format the book has on disk. */
export function isPreferredFormat(format: BookFormat, otherFormats: readonly BookFormat[]): boolean {
  return FORMAT_METADATA_RANK[format] < Math.min(...otherFormats.map((f) => FORMAT_METADATA_RANK[f]), Infinity);
}

/** Embedded metadata of a file, or none when it can't be read. */
async function readEmbedded(extract: Extractor, file: FileToLink): Promise<RawMetadata> {
  try {
    return await extract(file.abs, file.detected.format);
  } catch (err) {
    console.warn(`Metadata extraction failed for ${file.rel}:`, err);
    return {};
  }
}

export function createLinker(deps: LinkerDeps): Linker {
  const { db, index } = deps;
  let queue: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const parse = parseFilename;
  const merge = mergeMetadata;

  const hashOf = async (file: FileToLink): Promise<string> => {
    if (file.hash) return file.hash;
    const cached = hashCacheRepo.get(db, file.abs, file.size, file.mtimeMs);
    if (cached) return cached;
    const hash = await hashFile(file.abs);
    hashCacheRepo.put(db, file.abs, file.size, file.mtimeMs, hash);
    return hash;
  };

  const register = (file: FileToLink, hash: string, bookId: number): IndexedFile => {
    const indexed = toIndexedFile(file, hash, bookId);
    index.set(indexed);
    return indexed;
  };

  /**
   * A file joined an existing book by identifier. Unconfirmed metadata is purely derived from
   * files, so it is recomputed: the better-ranked format wins per field, the other fills gaps.
   * Confirmed metadata (external source or manual edit) is never touched.
   * Returns whether the new file is now the book's preferred metadata source.
   */
  const remergeDerived = (bookId: number, merged: MergeResult, format: BookFormat, exceptRel?: string): boolean => {
    const existing = bookRepo.get(db, bookId);
    if (!existing) return false;
    const others = index.filesOfBook(bookId).filter((f) => f.relPath !== exceptRel);
    const preferred = isPreferredFormat(format, others.map((f) => f.format));
    if (existing.confirmedSource !== null) return preferred;
    const current = pickMetadata(existing);
    const next = preferred ? fillMetadata(merged.metadata, current) : fillMetadata(current, merged.metadata);
    bookRepo.updateMetadata(db, bookId, pickMetadata(next), preferred ? merged.source : null);
    return preferred;
  };

  const attachOrCreate = (hash: string, format: BookFormat, merged: MergeResult, exceptRel?: string): Decision => {
    const { isbn13, doi } = merged.metadata;
    const candidate = bookRepo.bookIdsByIdentifiers(db, isbn13, doi).find((id) => !index.bookHasFormat(id, format, exceptRel));
    if (candidate !== undefined) {
      bookRepo.addHash(db, hash, candidate, format);
      return { bookId: candidate, outcome: "identifier", preferred: remergeDerived(candidate, merged, format, exceptRel) };
    }
    const id = bookRepo.create(db, merged.metadata, merged.source);
    bookRepo.addHash(db, hash, id, format);
    return { bookId: id, outcome: "created", preferred: true };
  };

  const afterLinkedNew = async (bookId: number, info: LinkedNewInfo, embedded: RawMetadata, file: FileToLink): Promise<void> => {
    if (!deps.onLinkedNew) return;
    try {
      await deps.onLinkedNew(bookId, info, embedded, file);
    } catch (err) {
      console.warn(`Post-link step failed for ${file.rel}:`, err);
    }
  };

  const link = async (file: FileToLink): Promise<LinkResult> => {
    const hash = await hashOf(file);
    if (file.hash) hashCacheRepo.put(db, file.abs, file.size, file.mtimeMs, hash);

    const known = await exclusive(() => {
      const id = bookRepo.bookIdByHash(db, hash);
      return id === null ? null : register(file, hash, id);
    });
    if (known) return { file: known, outcome: "hash" };

    // Unknown content: read metadata outside the lock (slow I/O), decide inside it.
    const parsed = parse(file.rel.slice(file.rel.lastIndexOf("/") + 1));
    const embedded = await readEmbedded(deps.extract, file);
    const merged = merge(embedded, parsed, file.detected.stem);

    const result = await exclusive(() => {
      const byHash = bookRepo.bookIdByHash(db, hash); // may have been linked meanwhile
      if (byHash !== null) return { file: register(file, hash, byHash), outcome: "hash" as const, preferred: true };
      const decision = attachOrCreate(hash, file.detected.format, merged, file.rel);
      return { file: register(file, hash, decision.bookId), outcome: decision.outcome, preferred: decision.preferred };
    });

    if (result.outcome !== "hash") await afterLinkedNew(result.file.bookId, { outcome: result.outcome, preferred: result.preferred }, embedded, file);
    return { file: result.file, outcome: result.outcome };
  };

  return { exclusive, parse, merge, hashOf, link, attachOrCreate, afterLinkedNew, register };
}
