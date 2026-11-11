import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { CoverImage } from "../metadata/types.ts";

export type CoverSize = "full" | "thumb";

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
      const input = sharp(image.data, { failOn: "none", limitInputPixels: 200_000_000, pages: 1 }).rotate();
      const meta = await input.metadata();
      if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) return false;
      const full = await input
        .clone()
        .resize({ width: 1200, height: 1800, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      const thumb = await input
        .clone()
        .resize({ width: 320, height: 480, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
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

  private writeAtomic(target: string, data: Buffer): void {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  }
}
