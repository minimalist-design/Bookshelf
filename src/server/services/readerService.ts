import { join } from "node:path";
import type { ExternalTools } from "../config.ts";
import type { BooksRepo } from "../db/repo/books.ts";
import { externalComicArchive, comicPages, zipComicArchive, type ComicArchive } from "../extract/comic.ts";
import { ppmToJpeg } from "../extract/djvu.ts";
import { mimeFromName } from "../extract/images.ts";
import { run, runText } from "../extract/subprocess.ts";
import { isZipFile } from "../extract/zip.ts";
import type { IndexedFile } from "../library/libraryIndex.ts";
import type { Library } from "../library/library.ts";
import { ValidationError } from "../library/paths.ts";
import type { ReadingPosition } from "../../shared/types.ts";
import { NotFoundError, UnavailableError } from "../api/http.ts";

export interface ReaderDeps {
  library: Library;
  books: BooksRepo;
  tools: ExternalTools;
}

interface PageSource {
  count: number;
  page(n: number): Promise<{ data: Uint8Array; mime: string } | null>;
}

const MAX_OPEN_SOURCES = 8;

/** Serves book files to the readers: page images for comics/DJVU, and reading positions. */
export class ReaderService {
  /** Small LRU of opened archives (listing a CBR via 7z is not free). */
  private readonly sources = new Map<string, Promise<PageSource>>();

  constructor(private readonly deps: ReaderDeps) {}

  /** The on-disk file `hash` of book `bookId` (404 unless both exist and belong together). */
  file(bookId: number, hash: string): { abs: string; file: IndexedFile } {
    const file = this.deps.library.index.filesOfBook(bookId).find((f) => f.hash === hash);
    const root = this.deps.library.rootPath;
    if (!file || !root) throw new NotFoundError("File not found");
    return { abs: join(root, file.relPath), file };
  }

  async pageCount(bookId: number, hash: string): Promise<number> {
    return (await this.source(bookId, hash)).count;
  }

  async page(bookId: number, hash: string, n: number): Promise<{ data: Uint8Array; mime: string }> {
    const src = await this.source(bookId, hash);
    if (!Number.isInteger(n) || n < 1 || n > src.count) throw new NotFoundError("No such page");
    const img = await src.page(n);
    if (!img) throw new UnavailableError("The page could not be extracted");
    return img;
  }

  private source(bookId: number, hash: string): Promise<PageSource> {
    const { abs, file } = this.file(bookId, hash);
    const key = `${abs}:${file.hash}`;
    const hit = this.sources.get(key);
    if (hit) {
      this.sources.delete(key); // refresh LRU order
      this.sources.set(key, hit);
      return hit;
    }
    const created = this.open(abs, file).catch((err) => {
      this.sources.delete(key);
      throw err;
    });
    this.sources.set(key, created);
    while (this.sources.size > MAX_OPEN_SOURCES) this.sources.delete(this.sources.keys().next().value!);
    return created;
  }

  private async open(abs: string, file: IndexedFile): Promise<PageSource> {
    const { tools } = this.deps;
    if (file.format === "cbz" || file.format === "cbr") {
      let archive: ComicArchive | null;
      if (file.format === "cbz" || (await isZipFile(abs))) archive = await zipComicArchive(abs);
      else archive = await externalComicArchive(abs, tools);
      if (!archive) throw new UnavailableError("Reading CBR files needs 7z or unrar on the server");
      const pages = comicPages(archive);
      return {
        count: pages.length,
        page: async (n) => {
          const name = pages[n - 1]!;
          const data = await archive.read(name);
          return data ? { data, mime: mimeFromName(name) } : null;
        },
      };
    }
    if (file.format === "djvu") {
      if (!tools.djvused || !tools.ddjvu) throw new UnavailableError("Reading DJVU files needs djvulibre (djvused, ddjvu) on the server");
      const count = Number((await runText([tools.djvused, abs, "-e", "n"]))?.trim());
      if (!(count > 0)) throw new UnavailableError("Could not read the DJVU document");
      const ddjvu = tools.ddjvu;
      return {
        count,
        page: async (n) => {
          const r = await run([ddjvu, "-format=ppm", `-page=${n}`, "-size=1800x2600", abs, "-"], 60_000, 64 * 1024 * 1024);
          const jpeg = r.exitCode === 0 ? await ppmToJpeg(r.stdout) : null;
          return jpeg ? { data: jpeg, mime: "image/jpeg" } : null;
        },
      };
    }
    throw new ValidationError(`${file.format.toUpperCase()} files are not served as page images`);
  }

  /** Save where the reader is. Not a metadata edit: does not confirm the book. */
  savePosition(bookId: number, body: { hash?: unknown; position?: unknown; fraction?: unknown }): ReadingPosition {
    if (typeof body?.hash !== "string" || typeof body.position !== "string" || body.position.length > 2000) {
      throw new ValidationError("hash and position are required");
    }
    this.file(bookId, body.hash); // must be a file of this book
    const f = body.fraction;
    const fraction = typeof f === "number" && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : null;
    const pos: ReadingPosition = { hash: body.hash, position: body.position, fraction, updatedAt: new Date().toISOString() };
    this.deps.books.setReadingPosition(bookId, JSON.stringify(pos));
    return pos;
  }
}
