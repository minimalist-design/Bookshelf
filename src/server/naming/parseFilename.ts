import { splitAuthors } from "./authors.ts";
import { doiFromFilename } from "./doi.ts";
import { detectFormat } from "./formats.ts";

/** `library`: a name in Bookshelf's own style; `plain`: anything else, read as nothing but its stem. */
export type NamePattern = "library" | "plain";

export interface ParsedFilename {
  readonly pattern: NamePattern;
  readonly title: string | null;
  readonly authors: readonly string[];
  readonly isbn13: string | null;
  readonly doi: string | null;
}

const LIBRARY = /^(.+?) - (.+?)(?: \[([^\]]+)\])?(?: \((\d+)\))?$/;
const UNKNOWN = "Unknown";

function tidy(s: string | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/**
 * Reads a filename (extension optional) written in Bookshelf's own style, `{author} - {title} [{id}]` with an
 * optional collision counter ` (2)`. Any other name is not interpreted: its stem is the title, with no authors.
 */
export function parseFilename(filename: string): ParsedFilename {
  const stem = detectFormat(filename)?.stem ?? filename;
  const m = LIBRARY.exec(stem.trim());
  if (!m) return { pattern: "plain", title: tidy(stem), authors: [], isbn13: null, doi: null };
  const [, authorPart, titlePart, bracket, counter] = m;
  const ids = bracket === undefined ? null : readBracket(bracket);
  // A bracket that isn't an ID belongs to the title; a collision counter only follows an ID bracket, so without
  // one it is part of the title too.
  const suffix = bracket === undefined ? (counter !== undefined ? ` (${counter})` : "") : ids ? "" : ` [${bracket}]`;
  const authors = authorPart!.trim() === UNKNOWN ? [] : splitAuthors(authorPart);
  return { pattern: "library", title: tidy(`${titlePart}${suffix}`), authors, isbn13: ids?.isbn13 ?? null, doi: ids?.doi ?? null };
}

/** The ISBN-13 or DOI in a `[…]` bracket as Bookshelf writes it, or null when the bracket is not an ID. */
function readBracket(bracket: string): Pick<ParsedFilename, "isbn13" | "doi"> | null {
  if (/^97[89]\d{10}$/.test(bracket)) return { isbn13: bracket, doi: null };
  const doi = /^10\.\d{4,9}_/.test(bracket) ? doiFromFilename(bracket) : null;
  return doi ? { isbn13: null, doi } : null;
}
