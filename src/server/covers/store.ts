import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverImage } from "../metadata/types.ts";

/*
 * Cover images live in the covers directory as they were given, named by book id with the image's own extension:
 * `{id}.jpg`, `{id}.png`, … Every function takes that directory first.
 */

const DECODE: Bun.Image.ConstructorOptions = { maxPixels: 200_000_000 };

/** Formats a browser shows, kept byte for byte, with their file extension and content type. */
const WEB_FORMATS: Partial<Record<Bun.Image.Format, { ext: string; type: string }>> = {
  jpeg: { ext: "jpg", type: "image/jpeg" },
  png: { ext: "png", type: "image/png" },
  webp: { ext: "webp", type: "image/webp" },
  gif: { ext: "gif", type: "image/gif" },
  avif: { ext: "avif", type: "image/avif" },
};
const EXTENSIONS = Object.values(WEB_FORMATS).map((f) => f!.ext);
const TYPE_OF_EXT: Record<string, string> = Object.fromEntries(Object.values(WEB_FORMATS).map((f) => [f!.ext, f!.type]));

export interface StoredCover {
  readonly path: string;
  readonly contentType: string;
}

const fileOf = (dir: string, bookId: number, ext: string) => join(dir, `${bookId}.${ext}`);

/** The book's cover file, or null when it has none. */
export function find(dir: string, bookId: number): StoredCover | null {
  const ext = EXTENSIONS.find((e) => existsSync(fileOf(dir, bookId, e)));
  return ext === undefined ? null : { path: fileOf(dir, bookId, ext), contentType: TYPE_OF_EXT[ext]! };
}

export function exists(dir: string, bookId: number): boolean {
  return find(dir, bookId) !== null;
}

/**
 * Store a cover as it is. Only a format browsers can't show (BMP, TIFF, HEIC) is converted, to PNG at its own size.
 * Returns false when the image can't be decoded or is too small to be a cover.
 */
export async function save(dir: string, bookId: number, image: CoverImage): Promise<boolean> {
  try {
    const meta = await new Bun.Image(image.data, DECODE).metadata();
    if (meta.width < 16 || meta.height < 16) return false;
    const web = WEB_FORMATS[meta.format];
    const [ext, data] = web ? [web.ext, image.data] : ["png", await new Bun.Image(image.data, DECODE).png().bytes()];
    const target = fileOf(dir, bookId, ext);
    writeAtomic(target, data);
    for (const other of EXTENSIONS.filter((e) => e !== ext)) rmSync(fileOf(dir, bookId, other), { force: true });
    return true;
  } catch (err) {
    console.warn(`Unusable cover image for book ${bookId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

export function remove(dir: string, bookId: number): void {
  for (const ext of EXTENSIONS) rmSync(fileOf(dir, bookId, ext), { force: true });
}

export function removeMany(dir: string, bookIds: Iterable<number>): void {
  for (const id of bookIds) remove(dir, id);
}

/** Weak validator for HTTP caching. */
export function etag(file: string): string | null {
  try {
    const st = statSync(file);
    return `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
  } catch {
    return null;
  }
}

/** Removes the thumbnails earlier versions made (`{id}.thumb.webp`); returns how many there were. */
export function removeLegacyThumbnails(dir: string): number {
  const names = (() => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  })();
  const thumbs = names.filter((n) => /^\d+\.thumb\.webp$/.test(n));
  for (const n of thumbs) rmSync(join(dir, n), { force: true });
  return thumbs.length;
}

function writeAtomic(target: string, data: Uint8Array): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}
