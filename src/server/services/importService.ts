import type { AppContext } from "../app.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import * as bookRepo from "../db/repo/books.ts";
import type { BookRecord } from "../db/repo/books.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import type { Extractor } from "../extract/index.ts";
import type { MergeResult } from "../extract/merge.ts";
import type { FileToLink } from "../library/linker.ts";
import { shelfOf, type IndexedFile } from "../library/libraryIndex.ts";
import { INCOMING_DIR, validateShelfName, ValidationError } from "../library/paths.ts";
import { buildLibraryFilename, withCollisionSuffix } from "../naming/buildFilename.ts";
import { detectFormat, type DetectedFormat } from "../naming/formats.ts";
import type { ImportResultDto, ImportStatus } from "../../shared/types.ts";
import { UnavailableError } from "../api/http.ts";

export type ImportDeps = Pick<AppContext, "db" | "library" | "extract" | "events" | "config">;

type PlacedStatus = Exclude<ImportStatus, "duplicate">;

interface Placed {
  status: PlacedStatus;
  bookId: number;
  file: FileToLink;
  preferred: boolean;
}

/**
 * Imports one uploaded file: stage it inside the library (hidden dir), hash it while
 * writing, reject duplicates, link it to its book, then move it into place under its
 * library filename. The original upload is a copy; nothing else is touched.
 */
export interface Importer {
  importStream(body: ReadableStream<Uint8Array> | null, originalName: string, shelfParam: string | null): Promise<ImportResultDto>;
}

const DEFAULT_MESSAGES: Record<ImportStatus, (detected: DetectedFormat) => string> = {
  imported: () => "Added to the library",
  attached: (d) => `Added ${d.format.toUpperCase()} to an existing book`,
  reconnected: () => "Restored with its saved metadata",
  duplicate: () => "Already in the library",
};

/** What an import reports back. */
export function importResult(
  status: ImportStatus,
  bookId: number,
  book: Pick<BookRecord, "title" | "authors"> | null,
  relPath: string | null,
  detected: DetectedFormat,
  message?: string,
): ImportResultDto {
  return {
    status,
    bookId,
    title: book?.title ?? "",
    authors: book?.authors ?? [],
    format: detected.format,
    relPath,
    shelf: relPath ? shelfOf(relPath) : null,
    message: message ?? DEFAULT_MESSAGES[status](detected),
    lookupQueued: false,
  };
}

/** A linked file joined a book: a new one, one that has files on disk, or a kept one whose files were gone. */
export function placedStatus(outcome: "identifier" | "created", hadFiles: boolean): PlacedStatus {
  return outcome === "created" ? "imported" : hadFiles ? "attached" : "reconnected";
}

/** New formats go next to the book's existing files; everything else into the chosen shelf ("" = the root). */
export function targetDir(status: PlacedStatus, existingFiles: readonly IndexedFile[], shelf: string | null): string {
  const dir = status === "attached" && existingFiles[0] ? posix.dirname(existingFiles[0].relPath) : (shelf ?? "");
  return dir === "." ? "" : dir;
}

/** `base` itself, or with the first collision counter that is free in `dirAbs`. */
function freeFilename(dirAbs: string, base: string, ext: string): string {
  let n = 1;
  while (existsSync(join(dirAbs, withCollisionSuffix(base, ext, n)))) n++;
  return withCollisionSuffix(base, ext, n);
}

export function createImporter(deps: ImportDeps): Importer {
  const { db, library } = deps;
  /** Uploads in flight; the staging directory is removed when this drops to zero. */
  let active = 0;

  const result = (status: ImportStatus, bookId: number, relPath: string | null, detected: DetectedFormat, message?: string) =>
    importResult(status, bookId, bookRepo.get(db, bookId), relPath, detected, message);

  /** Runs under the linker lock: no other import/scan decision can interleave. */
  const decide = (hash: string, detected: DetectedFormat, merged: MergeResult): Omit<Placed, "file"> | { duplicate: ImportResultDto } => {
    const index = library.index;
    const sameContent = index.fileWithHash(hash);
    if (sameContent) return { duplicate: result("duplicate", sameContent.bookId, sameContent.relPath, detected, "This exact file is already in the library") };

    // Content known from a kept (confirmed) book whose files are gone.
    const knownHash = bookRepo.bookIdByHash(db, hash);
    if (knownHash !== null) return { status: "reconnected", bookId: knownHash, preferred: true };

    const { isbn13, doi } = merged.metadata;
    const sameFormat = bookRepo
      .bookIdsByIdentifiers(db, isbn13, doi)
      .flatMap((id) => index.filesOfBook(id).filter((f) => f.format === detected.format).slice(0, 1))[0];
    if (sameFormat) {
      return { duplicate: result("duplicate", sameFormat.bookId, sameFormat.relPath, detected, `The library already has this book as ${detected.format.toUpperCase()}`) };
    }
    const decision = library.linker.attachOrCreate(hash, detected.format, merged);
    return { status: placedStatus(decision.outcome, index.hasBook(decision.bookId)), bookId: decision.bookId, preferred: decision.preferred };
  };

  /** Move the staged file into place and index it (no awaits: it must be indexed before the watcher looks at it). */
  const place = (root: string, tmp: string, hash: string, ext: string, shelf: string | null, decided: Omit<Placed, "file">): Placed => {
    const dirRel = targetDir(decided.status, library.index.filesOfBook(decided.bookId), shelf);
    const dirAbs = dirRel === "" ? root : join(root, dirRel);
    const filename = freeFilename(dirAbs, buildLibraryFilename(bookRepo.get(db, decided.bookId)!, ext), ext);
    const abs = join(dirAbs, filename);
    const rel = dirRel === "" ? filename : `${dirRel}/${filename}`;
    renameSync(tmp, abs);
    const st = statSync(abs);
    hashCacheRepo.put(db, abs, st.size, st.mtimeMs, hash);
    const file: FileToLink = { abs, rel, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), ino: st.ino, detected: detectFormat(filename)!, hash };
    library.linker.register(file, hash, decided.bookId);
    library.fileAdded(decided.bookId);
    return { ...decided, file };
  };

  return {
    async importStream(body, originalName, shelfParam) {
      const root = library.rootPath;
      if (!root) throw new UnavailableError("No library directory is configured");
      if (library.status().state === "unavailable") throw new UnavailableError("The library directory is not accessible");
      if (!body) throw new ValidationError("Empty upload");

      const name = originalName.split(/[\\/]/).pop()!.trim();
      const detected = detectFormat(name);
      if (!detected) throw new ValidationError(`Unsupported file type: ${name || "(no name)"}`);
      const shelf = shelfParam ? validateShelfName(shelfParam) : null;
      if (shelf !== null && !isDirectory(join(root, shelf))) throw new ValidationError(`Bookshelf does not exist: ${shelf}`);

      // Duplicate detection needs a complete index.
      await library.whenReady();

      const incoming = join(root, INCOMING_DIR);
      const ext = detected.ext.toLowerCase();
      const tmp = join(incoming, `${randomUUID()}${ext}`);
      active++;
      try {
        mkdirSync(incoming, { recursive: true });
        const { hash, size } = await writeAndHash(body, tmp, deps.config.maxUploadBytes);
        if (size === 0) throw new ValidationError("The file is empty");

        // Cheap check first: identical content already on disk.
        const sameContent = library.index.fileWithHash(hash);
        if (sameContent) return result("duplicate", sameContent.bookId, sameContent.relPath, detected, "This exact file is already in the library");

        const embedded = await deps.extract(tmp, detected.format);
        const merged = library.linker.merge(embedded, library.linker.parse(name), detected.stem);

        const placed = await library.linker.exclusive(() => {
          const decided = decide(hash, detected, merged);
          return "duplicate" in decided ? decided : place(root, tmp, hash, ext, shelf, decided);
        });
        if ("duplicate" in placed) return placed.duplicate;

        // Cover etc. are read again from the final location (closures from the staging file are stale).
        const finalEmbedded = await deps.extract(placed.file.abs, detected.format);
        if (placed.status !== "reconnected" || !bookRepo.get(db, placed.bookId)?.hasCover) {
          await library.linker.afterLinkedNew(
            placed.bookId,
            { outcome: placed.status === "imported" ? "created" : "identifier", preferred: placed.preferred },
            finalEmbedded,
            placed.file,
          );
        }
        deps.events.libraryChanged([placed.bookId]);
        return result(placed.status, placed.bookId, placed.file.rel, detected);
      } finally {
        rmSync(tmp, { force: true });
        // Single process: no other upload can be staging once the counter reaches zero.
        if (--active === 0) {
          try {
            rmdirSync(incoming);
          } catch {
            /* not empty or already gone */
          }
        }
      }
    },
  };
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Stream the request body to disk, hashing on the way. */
async function writeAndHash(body: ReadableStream<Uint8Array>, path: string, maxBytes: number): Promise<{ hash: string; size: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  const sink = Bun.file(path).writer({ highWaterMark: 1024 * 1024 });
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ValidationError(`File exceeds the upload limit of ${Math.round(maxBytes / 1024 / 1024)} MB`);
      hasher.update(chunk);
      sink.write(chunk);
    }
  } finally {
    await sink.end();
  }
  return { hash: hasher.digest("hex"), size };
}
