import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/*
 * Cover images live in the covers directory, named by book id: `{id}.jpg` and `{id}.thumb.webp`.
 * Every function takes that directory first.
 */

export function path(dir: string, bookId: number, size: CoverSize): string {
  return join(dir, size === "full" ? `${bookId}.jpg` : `${bookId}.thumb.webp`);
}

export function exists(dir: string, bookId: number): boolean {
  return existsSync(path(dir, bookId, "full"));
}

/** Decode, normalize and store a cover. Returns false when the image cannot be decoded. */
export async function save(dir: string, bookId: number, image: CoverImage): Promise<boolean> {
  try {
    const meta = await new Bun.Image(image.data, DECODE).metadata();
    if (meta.width < 16 || meta.height < 16) return false;
    const full = await fullJpeg(image.data, meta.format);
    const thumb = await new Bun.Image(image.data, DECODE)
      .resize(THUMB[0], THUMB[1], FIT)
      .webp({ quality: 80 })
      .bytes();
    writeAtomic(path(dir, bookId, "full"), full);
    writeAtomic(path(dir, bookId, "thumb"), thumb);
    return true;
  } catch (err) {
    console.warn(`Unusable cover image for book ${bookId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Move a book's cover files to another book id (used when merging books). */
export function adopt(dir: string, fromId: number, toId: number): void {
  for (const size of SIZES) {
    const from = path(dir, fromId, size);
    if (existsSync(from)) renameSync(from, path(dir, toId, size));
  }
}

export function remove(dir: string, bookId: number): void {
  for (const size of SIZES) rmSync(path(dir, bookId, size), { force: true });
}

export function removeMany(dir: string, bookIds: Iterable<number>): void {
  for (const id of bookIds) remove(dir, id);
}

/** Weak validator for HTTP caching. */
export function etag(dir: string, bookId: number, size: CoverSize): string | null {
  try {
    const st = statSync(path(dir, bookId, size));
    return `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
  } catch {
    return null;
  }
}

export interface CoverFile {
  readonly path: string;
  /** Null for a file that isn't named like a cover (e.g. a stray temp file). */
  readonly bookId: number | null;
  readonly size: number;
}

/** The book a file in the covers directory belongs to, from its name. */
export function bookIdOfCoverFile(name: string): number | null {
  const m = /^(\d+)\.(jpg|thumb\.webp)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Every file in the covers directory. */
export function listFiles(dir: string): CoverFile[] {
  const names = (() => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  })();
  return names.map((name) => ({ path: join(dir, name), bookId: bookIdOfCoverFile(name), size: sizeOf(join(dir, name)) }));
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0; // vanished
  }
}

const SIZES = ["full", "thumb"] as const;

function writeAtomic(target: string, data: Uint8Array): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
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
