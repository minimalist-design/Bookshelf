import { splitAuthors } from "./authors.ts";
import { doiFromFilename } from "./doi.ts";
import { detectFormat } from "./formats.ts";
import { isValidIsbn13, normalizeIsbn } from "./isbn.ts";

export type NamePattern = "import" | "library" | "plain";

export interface ParsedFilename {
  pattern: NamePattern;
  title: string | null;
  authors: string[];
  isbn13: string | null;
  /** False when an ISBN-13 was found but its checksum is wrong (it is still kept). */
  isbn13Valid: boolean;
  doi: string | null;
  /** The raw DOI token as written in the filename (useful to retry ambiguous `_` reversals). */
  doiToken: string | null;
}

const IMPORT_SEP = " -- ";
// `isbn13 9780131103627`, `isbn13: 978-0-13-110362-7`, `isbn 9780131103627`
const ISBN_TOKEN = /\bisbn(?:[\s_-]?13)?[\s:_]+(97[89](?:[\s-]?\d){10})(?!\d)/i;
// `doi 10.1000_xyz` / `doi: 10.1000/xyz` — suffix runs to whitespace or end.
const DOI_TOKEN = /\bdoi[\s:_]+(10\.\d{4,9}[_\/][^\s]+)/i;

function emptyResult(pattern: NamePattern): ParsedFilename {
  return { pattern, title: null, authors: [], isbn13: null, isbn13Valid: true, doi: null, doiToken: null };
}

function tidy(s: string | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/** Accepts a full filename (extension optional). */
export function parseFilename(filename: string): ParsedFilename {
  const stem = detectFormat(filename)?.stem ?? filename;
  return stem.includes(IMPORT_SEP) ? parseImportPattern(stem) : parseLibraryOrPlain(stem);
}

/** `{title} -- {author}[ -- …]` with `isbn13 …` / `doi …` tokens anywhere. */
function parseImportPattern(stem: string): ParsedFilename {
  const out = emptyResult("import");
  const positional: string[] = [];

  for (const rawSegment of stem.split(IMPORT_SEP)) {
    let segment = rawSegment;
    const isbnMatch = ISBN_TOKEN.exec(segment);
    if (isbnMatch && !out.isbn13) {
      out.isbn13 = normalizeIsbn(isbnMatch[1]!);
      segment = segment.replace(isbnMatch[0], " ");
    }
    const doiMatch = DOI_TOKEN.exec(segment);
    if (doiMatch && !out.doi) {
      const token = doiMatch[1]!.replace(/[.,;)]+$/, "");
      out.doi = doiFromFilename(token);
      out.doiToken = out.doi ? token : null;
      segment = segment.replace(doiMatch[0], " ");
    }
    // Segments that only held ID tokens don't take a positional slot.
    if (tidy(segment) !== null || segment === rawSegment) positional.push(segment);
  }

  out.title = tidy(positional[0]);
  out.authors = splitAuthors(tidy(positional[1]));
  if (out.isbn13) out.isbn13Valid = isValidIsbn13(out.isbn13);
  return out;
}

const LIBRARY = /^(.+?) - (.+?)(?: \[([^\]]+)\])?(?: \((\d+)\))?$/;

/** `{author} - {title} [{id}]` (as written by the app), else the whole stem is the title. */
function parseLibraryOrPlain(stem: string): ParsedFilename {
  const m = LIBRARY.exec(stem.trim());
  if (!m) {
    const out = emptyResult("plain");
    out.title = tidy(stem);
    return out;
  }
  const [, authorPart, titlePart, bracket, counter] = m;
  const out = emptyResult("library");
  let title = titlePart!;

  if (bracket !== undefined) {
    const compact = bracket.replace(/[\s-]/g, "");
    if (/^97[89]\d{10}$/.test(compact)) {
      out.isbn13 = compact;
      out.isbn13Valid = isValidIsbn13(compact);
    } else if (/^10\.\d{4,9}[_\/]/.test(bracket)) {
      out.doi = doiFromFilename(bracket);
      out.doiToken = out.doi ? bracket : null;
    } else {
      title += ` [${bracket}]`; // not an ID: belongs to the title
    }
  }
  // A collision counter is only meaningful after an ID bracket; otherwise it is part of the title.
  if (counter !== undefined && bracket === undefined) title += ` (${counter})`;

  out.title = tidy(title);
  const authors = splitAuthors(authorPart);
  out.authors = authors.length === 1 && authors[0] === "Unknown" ? [] : authors;
  return out;
}
