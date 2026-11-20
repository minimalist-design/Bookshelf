import { splitAuthors } from "./authors.ts";
import { doiFromFilename } from "./doi.ts";
import { detectFormat } from "./formats.ts";
import { isValidIsbn13, normalizeIsbn } from "./isbn.ts";
import { orientationMargin, orientationOf, personNameScore, type KnownAuthor } from "./nameShape.ts";

export type NamePattern = "import" | "library" | "plain";

export interface ParsedFilename {
  readonly pattern: NamePattern;
  readonly title: string | null;
  readonly authors: readonly string[];
  readonly isbn13: string | null;
  /** False when an ISBN-13 was found but its checksum is wrong (it is still kept). */
  readonly isbn13Valid: boolean;
  readonly doi: string | null;
  /** The raw DOI token as written in the filename (useful to retry ambiguous `_` reversals). */
  readonly doiToken: string | null;
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

export interface ParseOptions {
  /** Whether a name is already an author in the library; helps tell "Title - Author" from "Author - Title". */
  isKnownAuthor?: KnownAuthor;
}

/** Accepts a full filename (extension optional). */
export function parseFilename(filename: string, opts: ParseOptions = {}): ParsedFilename {
  const stem = detectFormat(filename)?.stem ?? filename;
  return stem.includes(IMPORT_SEP) ? parseImportPattern(stem, opts) : parseLibraryOrPlain(stem, opts);
}

interface ImportScan {
  isbn13: string | null;
  doi: string | null;
  doiToken: string | null;
  positional: string[];
}

/**
 * Take the ISBN and DOI tokens out of one ` -- ` segment. Only the first ID of each kind is used:
 * once one is found, later tokens stay in their segments.
 */
function scanSegment(acc: ImportScan, raw: string): ImportScan {
  const isbnMatch = acc.isbn13 ? null : ISBN_TOKEN.exec(raw);
  const afterIsbn = isbnMatch ? raw.replace(isbnMatch[0], " ") : raw;
  const doiMatch = acc.doi ? null : DOI_TOKEN.exec(afterIsbn);
  const segment = doiMatch ? afterIsbn.replace(doiMatch[0], " ") : afterIsbn;
  const token = doiMatch ? doiMatch[1]!.replace(/[.,;)]+$/, "") : null;
  const doi = token !== null ? doiFromFilename(token) : acc.doi;
  return {
    isbn13: isbnMatch ? normalizeIsbn(isbnMatch[1]!) : acc.isbn13,
    doi,
    doiToken: token !== null ? (doi ? token : null) : acc.doiToken,
    // Segments that only held ID tokens don't take a positional slot.
    positional: tidy(segment) !== null || segment === raw ? [...acc.positional, segment] : acc.positional,
  };
}

/**
 * `{title} -- {author}[ -- …]` with `isbn13 …` / `doi …` tokens anywhere. The first two segments
 * are swapped only when the first is clearly a name and the second clearly a title.
 */
function parseImportPattern(stem: string, opts: ParseOptions): ParsedFilename {
  const { positional, isbn13, doi, doiToken } = stem
    .split(IMPORT_SEP)
    .reduce<ImportScan>(scanSegment, { isbn13: null, doi: null, doiToken: null, positional: [] });
  const [first, second] = [tidy(positional[0]), tidy(positional[1])];
  const swapped =
    first !== null &&
    second !== null &&
    personNameScore(second, opts.isKnownAuthor) <= -2 &&
    orientationOf(personNameScore(first, opts.isKnownAuthor), personNameScore(second, opts.isKnownAuthor)) === "first-is-author";
  return {
    pattern: "import",
    title: swapped ? second : first,
    authors: splitAuthors(swapped ? first : second),
    isbn13,
    isbn13Valid: isbn13 ? isValidIsbn13(isbn13) : true,
    doi,
    doiToken,
  };
}

const LIBRARY = /^(.+?) - (.+?)(?: \[([^\]]+)\])?(?: \((\d+)\))?$/;
const LIBRARY_SEP = " - ";
const UNKNOWN = "Unknown";

/**
 * `{author} - {title} [{id}]` as written by the app, or `{title} - {author}` as many downloads are
 * named; else the whole stem is the title.
 *
 * With an ID bracket the name was written by the app, so it is read in the app's order. Without
 * one, the split (at any ` - `) and the order come from which side reads as a person's name,
 * falling back to the app's order at the first ` - ` when the names don't say.
 */
function parseLibraryOrPlain(stem: string, opts: ParseOptions): ParsedFilename {
  const m = LIBRARY.exec(stem.trim());
  if (!m) return { ...emptyResult("plain"), title: tidy(stem) };
  const [, authorPart, titlePart, bracket, counter] = m;
  const ids = bracket === undefined ? null : readBracket(bracket);
  // A bracket that isn't an ID belongs to the title; a collision counter is only meaningful
  // after an ID bracket, so without any bracket it is part of the title too.
  const suffix = bracket === undefined ? (counter !== undefined ? ` (${counter})` : "") : ids ? "" : ` [${bracket}]`;
  const title = `${titlePart}${suffix}`;

  const named = ids
    ? { author: authorPart!, title }
    : orientName(`${authorPart}${LIBRARY_SEP}${title}`, opts) ?? { author: authorPart!, title };
  const authors = splitAuthors(named.author);
  return {
    ...emptyResult("library"),
    ...ids,
    title: tidy(named.title),
    authors: authors.length === 1 && authors[0] === UNKNOWN ? [] : authors,
  };
}

type BracketIds = Pick<ParsedFilename, "isbn13" | "isbn13Valid" | "doi" | "doiToken">;

/** The ISBN or DOI in an app-written `[…]` bracket, or null when the bracket is not an ID. */
function readBracket(bracket: string): BracketIds | null {
  const compact = bracket.replace(/[\s-]/g, "");
  if (/^97[89]\d{10}$/.test(compact)) return { isbn13: compact, isbn13Valid: isValidIsbn13(compact), doi: null, doiToken: null };
  if (!/^10\.\d{4,9}[_\/]/.test(bracket)) return null;
  const doi = doiFromFilename(bracket);
  return { isbn13: null, isbn13Valid: true, doi, doiToken: doi ? bracket : null };
}

/**
 * The surest way to read `name` as author and title: every ` - ` is a possible split, each side
 * possibly the author. `null` when no split has a clear person's name on one side only.
 */
function orientName(name: string, opts: ParseOptions): { author: string; title: string } | null {
  const pieces = name.split(LIBRARY_SEP);
  if (pieces[0]?.trim() === UNKNOWN) return null; // the app's own "Unknown - Title"
  const candidates = pieces.slice(1).flatMap((_, i) => {
    const left = pieces.slice(0, i + 1).join(LIBRARY_SEP);
    const right = pieces.slice(i + 1).join(LIBRARY_SEP);
    if (right.trim() === UNKNOWN) return [{ author: right, title: left, name: Infinity, margin: Infinity }];
    const [a, b] = [personNameScore(left, opts.isKnownAuthor), personNameScore(right, opts.isKnownAuthor)];
    const o = orientationOf(a, b);
    if (!o) return [];
    const margin = orientationMargin(a, b);
    return [o === "first-is-author" ? { author: left, title: right, name: a, margin } : { author: right, title: left, name: b, margin }];
  });
  // The most name-like author wins; the gap only breaks ties (a long title side always looks very
  // unlike a name, so the gap alone would favour splits that leave title pieces on the author side).
  const better = (c: (typeof candidates)[number], b: (typeof candidates)[number]) => c.name > b.name || (c.name === b.name && c.margin > b.margin);
  const best = candidates.reduce<(typeof candidates)[number] | null>((b, c) => (b === null || better(c, b) ? c : b), null);
  return best && { author: best.author, title: best.title };
}
