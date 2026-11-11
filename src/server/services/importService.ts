import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { BooksRepo } from "../db/repo/books.ts";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Extractor } from "../extract/index.ts";
import { mergeMetadata } from "../extract/merge.ts";
import type { Library } from "../library/library.ts";
import type { FileToLink } from "../library/linker.ts";
import { INCOMING_DIR, validateShelfName, ValidationError } from "../library/paths.ts";
import { buildLibraryFilename, withCollisionSuffix } from "../naming/buildFilename.ts";
import { detectFormat, type DetectedFormat } from "../naming/formats.ts";
import { parseFilename } from "../naming/parseFilename.ts";
import type { ImportResultDto, ImportStatus } from "../../shared/types.ts";
import { UnavailableError } from "../api/http.ts";

export interface ImportDeps {
  library: Library;
  books: BooksRepo;
  hashCache: HashCacheRepo;
  extract: Extractor;
  events: EventBus;
  maxUploadBytes: number;
}

interface Placed {
  status: Exclude<ImportStatus, "duplicate">;
  bookId: number;
  file: FileToLink;
  preferred: boolean;
}

/**
 * Imports one uploaded file: stage it inside the library (hidden dir), hash it while
 * writing, reject duplicates, link it to its book, then move it into place under its
 * library filename. The original upload is a copy; nothing else is touched.
 */
export class ImportService {
  /** Uploads in flight; the staging directory is removed when this drops to zero. */
  private active = 0;

  constructor(private readonly deps: ImportDeps) {}

  async importStream(body: ReadableStream<Uint8Array> | null, originalName: string, shelfParam: string | null): Promise<ImportResultDto> {
    const { library } = this.deps;
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
    this.active++;
    try {
      mkdirSync(incoming, { recursive: true });
      const { hash, size } = await writeAndHash(body, tmp, this.deps.maxUploadBytes);
      if (size === 0) throw new ValidationError("The file is empty");

      // Cheap check first: identical content already on disk.
      const sameContent = library.index.fileWithHash(hash);
      if (sameContent) return this.duplicate(sameContent.bookId, sameContent.relPath, detected, "This exact file is already in the library");

      const embedded = await this.deps.extract(tmp, detected.format);
      const merged = mergeMetadata(embedded, parseFilename(name), detected.stem);

      const placed = await library.linker.exclusive(() => this.decideAndPlace(root, tmp, hash, detected, ext, shelf, merged));
      if ("duplicate" in placed) return placed.duplicate;

      // Cover etc. are read again from the final location (closures from the staging file are stale).
      const finalEmbedded = await this.deps.extract(placed.file.abs, detected.format);
      if (placed.status !== "reconnected" || !this.deps.books.get(placed.bookId)?.hasCover) {
        await library.linker.afterLinkedNew(
          placed.bookId,
          { outcome: placed.status === "imported" ? "created" : "identifier", preferred: placed.preferred },
          finalEmbedded,
          placed.file,
        );
      }
      this.deps.events.libraryChanged([placed.bookId]);
      return this.result(placed.status, placed.bookId, placed.file.rel, detected);
    } finally {
      rmSync(tmp, { force: true });
      // Single process: no other upload can be staging once the counter reaches zero.
      if (--this.active === 0) {
        try {
          rmdirSync(incoming);
        } catch {
          /* not empty or already gone */
        }
      }
    }
  }

  /** Runs under the linker lock: no other import/scan decision can interleave. */
  private decideAndPlace(
    root: string,
    tmp: string,
    hash: string,
    detected: DetectedFormat,
    ext: string,
    shelf: string | null,
    merged: ReturnType<typeof mergeMetadata>,
  ): Placed | { duplicate: ImportResultDto } {
    const { library, books, hashCache } = this.deps;
    const index = library.index;

    const sameContent = index.fileWithHash(hash);
    if (sameContent) return { duplicate: this.duplicate(sameContent.bookId, sameContent.relPath, detected, "This exact file is already in the library") };

    let bookId: number;
    let status: Placed["status"];
    let preferred = true;
    const knownHash = books.bookIdByHash(hash);
    if (knownHash !== null) {
      // Content known from a kept (confirmed) book whose files are gone.
      bookId = knownHash;
      status = "reconnected";
    } else {
      const { isbn13, doi } = merged.metadata;
      for (const candidate of books.bookIdsByIdentifiers(isbn13, doi)) {
        const existing = index.filesOfBook(candidate).find((f) => f.format === detected.format);
        if (existing) {
          return { duplicate: this.duplicate(candidate, existing.relPath, detected, `The library already has this book as ${detected.format.toUpperCase()}`) };
        }
      }
      const hadFiles = (id: number) => index.hasBook(id);
      const decision = library.linker.attachOrCreate(hash, detected.format, merged);
      bookId = decision.bookId;
      preferred = decision.preferred;
      status = decision.outcome === "created" ? "imported" : hadFiles(bookId) ? "attached" : "reconnected";
    }

    // New formats go next to the book's existing files; everything else into the chosen shelf.
    const existingFiles = index.filesOfBook(bookId);
    const dirRel = status === "attached" && existingFiles[0] ? posix.dirname(existingFiles[0].relPath) : (shelf ?? "");
    const dirAbs = dirRel === "." || dirRel === "" ? root : join(root, dirRel);
    const book = books.get(bookId)!;
    const base = buildLibraryFilename(book, ext);
    let n = 1;
    while (existsSync(join(dirAbs, withCollisionSuffix(base, ext, n)))) n++;
    const filename = withCollisionSuffix(base, ext, n);
    const abs = join(dirAbs, filename);
    const rel = dirRel === "." || dirRel === "" ? filename : `${dirRel}/${filename}`;

    // No awaits from here on: the file must be indexed before the watcher looks at it.
    renameSync(tmp, abs);
    const st = statSync(abs);
    hashCache.put(abs, st.size, st.mtimeMs, hash);
    const file: FileToLink = { abs, rel, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), ino: st.ino, detected: detectFormat(filename)!, hash };
    library.linker.register(file, hash, bookId);
    library.retention.fileAdded(bookId);
    return { status, bookId, file, preferred };
  }

  private result(status: ImportStatus, bookId: number, relPath: string | null, detected: DetectedFormat, message?: string): ImportResultDto {
    const book = this.deps.books.get(bookId);
    const shelf = relPath && relPath.includes("/") ? relPath.slice(0, relPath.indexOf("/")) : null;
    const defaults: Record<ImportStatus, string> = {
      imported: "Added to the library",
      attached: `Added ${detected.format.toUpperCase()} to an existing book`,
      reconnected: "Restored with its saved metadata",
      duplicate: "Already in the library",
    };
    return {
      status,
      bookId,
      title: book?.title ?? "",
      authors: book?.authors ?? [],
      format: detected.format,
      relPath,
      shelf,
      message: message ?? defaults[status],
    };
  }

  private duplicate(bookId: number, relPath: string, detected: DetectedFormat, message: string): ImportResultDto {
    return this.result("duplicate", bookId, relPath, detected, message);
  }
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
