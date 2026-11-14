import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverImage } from "../metadata/types.ts";
import { decodePng, flattenOnWhite } from "./raster.ts";

export type CoverSize = "full" | "thumb";

const DECODE: Bun.Image.ConstructorOptions = { maxPixels: 200_000_000 };
const FULL = [1200, 1800] as const;
const THUMB = [320, 480] as const;
const FIT: Bun.Image.ResizeOptions = { fit: "inside", withoutEnlargement: true };
/** Source formats that may carry transparency, which JPEG cannot hold. */
const MAY_HAVE_ALPHA = new Set<Bun.Image.Format>(["png", "webp", "gif"]);

/** Cover images live in the data directory, named by book id: `{id}.jpg` and `{id}.thumb.webp`. */
export class CoverStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(bookId: number, size: CoverSize): string {
    return join(this.dir, size === "full" ? `${bookId}.jpg` : `${bookId}.thumb.webp`);
  }

  exists(bookId: number): boolean {
    return existsSync(this.path(bookId, "full"));
  }

  /** Decode, normalize and store a cover. Returns false when the image cannot be decoded. */
  async save(bookId: number, image: CoverImage): Promise<boolean> {
    try {
      const meta = await new Bun.Image(image.data, DECODE).metadata();
      if (meta.width < 16 || meta.height < 16) return false;
      const full = await fullJpeg(image.data, meta.format);
      const thumb = await new Bun.Image(image.data, DECODE)
        .resize(THUMB[0], THUMB[1], FIT)
        .webp({ quality: 80 })
        .bytes();
      this.writeAtomic(this.path(bookId, "full"), full);
      this.writeAtomic(this.path(bookId, "thumb"), thumb);
      return true;
    } catch (err) {
      console.warn(`Unusable cover image for book ${bookId}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Move a book's cover files to another book id (used when merging books). */
  adopt(fromId: number, toId: number): void {
    for (const size of ["full", "thumb"] as const) {
      const from = this.path(fromId, size);
      if (existsSync(from)) renameSync(from, this.path(toId, size));
    }
  }

  remove(bookId: number): void {
    rmSync(this.path(bookId, "full"), { force: true });
    rmSync(this.path(bookId, "thumb"), { force: true });
  }

  removeMany(bookIds: Iterable<number>): void {
    for (const id of bookIds) this.remove(id);
  }

  /** Weak validator for HTTP caching. */
  etag(bookId: number, size: CoverSize): string | null {
    try {
      const st = statSync(this.path(bookId, size));
      return `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
    } catch {
      return null;
    }
  }

  private writeAtomic(target: string, data: Uint8Array): void {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  }
}

/** Resized JPEG; transparent sources are composited onto white first (Bun.Image would just drop alpha). */
async function fullJpeg(data: Uint8Array, format: Bun.Image.Format): Promise<Uint8Array> {
  const resized = () => new Bun.Image(data, DECODE).resize(FULL[0], FULL[1], FIT);
  if (MAY_HAVE_ALPHA.has(format)) {
    const decoded = decodePng(await resized().png({ compressionLevel: 1 }).bytes());
    if (decoded && (decoded.channels === 2 || decoded.channels === 4)) {
      return new Bun.Image(flattenOnWhite(decoded)).jpeg({ quality: 85 }).bytes();
    }
  }
  return resized().jpeg({ quality: 85 }).bytes();
}
