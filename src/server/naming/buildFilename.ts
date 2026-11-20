import { authorsForFilename } from "./authors.ts";
import { doiToFilename } from "./doi.ts";
import { byteLength, sanitizeAuthorPart, sanitizeComponent, truncateBytes } from "./sanitize.ts";

export interface NameableMetadata {
  title: string;
  authors: readonly string[];
  isbn13?: string | null;
  doi?: string | null;
}

/** Linux NAME_MAX. */
export const MAX_FILENAME_BYTES = 255;
/** Room kept for a collision suffix like " (12)". */
const COLLISION_RESERVE = 6;

/** The bracketed ID token: bare ISBN-13, else DOI with `/` → `_`. */
export function idToken(meta: Pick<NameableMetadata, "isbn13" | "doi">): string | null {
  if (meta.isbn13) return meta.isbn13;
  if (meta.doi) return sanitizeComponent(doiToFilename(meta.doi));
  return null;
}

/**
 * Build the library filename stem: `{author} - {title} [{id}]`.
 * `ext` includes the leading dot and is appended unchanged.
 */
export function buildLibraryFilename(meta: NameableMetadata, ext: string): string {
  const author = sanitizeAuthorPart(authorsForFilename(meta.authors)) || "Unknown";
  const title = sanitizeComponent(meta.title) || "Untitled";
  const id = idToken(meta);
  const idPart = id ? ` [${id}]` : "";
  const budget = MAX_FILENAME_BYTES - COLLISION_RESERVE - byteLength(ext) - byteLength(idPart);

  const sep = " - ";
  const fits = (a: string, t: string) => byteLength(a) + byteLength(sep) + byteLength(t) <= budget;
  // Shrink the title first, keeping at least ~40 bytes of it, then the author part.
  const t = fits(author, title)
    ? title
    : truncateBytes(title, Math.max(Math.min(byteLength(title), 40), budget - byteLength(author) - byteLength(sep)));
  const a = fits(author, t) ? author : truncateBytes(author, Math.max(1, budget - byteLength(sep) - byteLength(t)));
  return `${a}${sep}${t}${idPart}${ext}`;
}

/** Insert a collision counter before the extension: "X [id].epub" → "X [id] (2).epub". */
export function withCollisionSuffix(filename: string, ext: string, n: number): string {
  if (n <= 1) return filename;
  return `${filename.slice(0, filename.length - ext.length)} (${n})${ext}`;
}
