import { foldKey } from "../cleanup/similarity.ts";
import { uniqueCaseless } from "../collections.ts";
import { splitAuthors } from "../naming/authors.ts";
import { NAME_SCORE, orientation, personNameScore, type KnownAuthor } from "../naming/nameShape.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import type { BookFormat } from "../naming/formats.ts";
import type { ParsedFilename } from "../naming/parseFilename.ts";
import type { BookMetadata, MetadataSource, RawMetadata } from "../metadata/types.ts";
import { isJunkAuthor, isJunkTitle } from "./junk.ts";

export interface MergeResult {
  readonly metadata: BookMetadata;
  readonly source: MetadataSource;
}

function text(v: string | null | undefined): string | null {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

export interface MergeOptions {
  isKnownAuthor?: KnownAuthor;
}

const same = (a: string | null, b: string | null) => a !== null && b !== null && foldKey(a) === foldKey(b);

/**
 * Embedded title and authors with the usual mix-ups undone (PDF metadata especially):
 * - an author that only repeats the title or the filename is dropped;
 * - a single author that reads as a title, with a title that reads as a name, are swapped back;
 * - title-like authors give way to name-like authors from the filename, and a title that is
 *   just the filename's author gives way to the filename's title.
 */
function embeddedNames(
  embedded: RawMetadata,
  parsed: ParsedFilename,
  fileStem: string,
  known: KnownAuthor | undefined,
): { title: string | null; authors: string[] } {
  const title = text(embedded.title);
  const authors = (embedded.authors ?? [])
    .map((a) => text(a))
    .filter((a): a is string => a !== null && !same(a, title) && !same(a, fileStem));

  if (title && authors.length === 1 && orientation(authors[0]!, title, known) === "second-is-author") {
    return { title: authors[0]!, authors: [title] };
  }
  const filenameHasNames = parsed.authors.length > 0 && personNameScore(parsed.authors.join("; "), known) >= NAME_SCORE.clearlyName;
  if (!filenameHasNames) return { title, authors };
  const authorsAreTitle = authors.length > 0 && personNameScore(authors.join("; "), known) <= NAME_SCORE.clearlyTitle;
  const titleIsFilenameAuthor = title !== null && parsed.title !== null && parsed.authors.some((a) => same(a, title) || same(splitAuthors(title)[0] ?? null, a));
  return {
    title: titleIsFilenameAuthor ? null : title,
    authors: authorsAreTitle ? [] : authors,
  };
}

type Origin = "embedded" | "filename" | null;

/**
 * An embedded title that merely repeats a *structured* filename ("T -- A -- isbn13 …") is junk;
 * a plain filename equal to the title ("dune.epub" / "Dune") is just a well-named file.
 */
function chooseTitle(embTitle: string | null, parsed: ParsedFilename, fileStem: string): { value: string; from: Origin } {
  if (embTitle && !isJunkTitle(embTitle, parsed.pattern === "plain" ? undefined : fileStem)) return { value: embTitle, from: "embedded" };
  if (parsed.title) return { value: parsed.title, from: "filename" };
  return { value: text(fileStem) ?? "Untitled", from: "filename" };
}

function chooseAuthors(embAuthors: readonly string[], parsed: ParsedFilename): { value: readonly string[]; from: Origin } {
  if (embAuthors.length) return { value: embAuthors, from: "embedded" };
  if (parsed.authors.length) return { value: parsed.authors, from: "filename" };
  return { value: [], from: null };
}

/**
 * Field-level merge: each embedded value wins unless it is junk; empty fields are
 * filled from the filename. isbn13/doi found in the filename always win.
 */
export function mergeMetadata(embedded: RawMetadata, parsed: ParsedFilename, fileStem: string, opts: MergeOptions = {}): MergeResult {
  const names = embeddedNames(embedded, parsed, fileStem, opts.isKnownAuthor);
  const title = chooseTitle(names.title, parsed, fileStem);
  const authors = chooseAuthors(
    names.authors.flatMap((a) => splitAuthors(a)).filter((a) => !isJunkAuthor(a)),
    parsed,
  );
  const publishedDate = text(embedded.publishedDate);
  const series = text(embedded.series);
  const metadata: BookMetadata = {
    title: title.value,
    subtitle: text(embedded.subtitle),
    authors: authors.value,
    isbn13: parsed.isbn13 ?? normalizeIsbn(embedded.isbn13),
    doi: parsed.doi ?? normalizeDoi(embedded.doi),
    publisher: text(embedded.publisher),
    edition: null,
    publishedDate,
    year: embedded.year ?? yearFrom(publishedDate),
    language: text(embedded.language),
    pages: embedded.pages && embedded.pages > 0 ? Math.round(embedded.pages) : null,
    description: text(embedded.description),
    series,
    seriesIndex: series && embedded.seriesIndex != null && Number.isFinite(embedded.seriesIndex) ? embedded.seriesIndex : null,
    tags: uniqueCaseless((embedded.tags ?? []).map((t) => text(t)).filter((t): t is string => !!t && t.length <= 64)),
  };

  const origins = [title.from, authors.from];
  const usedFilename = origins.includes("filename") || !!(parsed.isbn13 || parsed.doi);
  const usedEmbedded =
    origins.includes("embedded") ||
    (!parsed.isbn13 && !!metadata.isbn13) ||
    (!parsed.doi && !!metadata.doi) ||
    !!(metadata.subtitle || metadata.publisher || metadata.description || metadata.series || metadata.tags.length);
  const source: MetadataSource = usedEmbedded && usedFilename ? "mixed" : usedEmbedded ? "embedded" : "filename";
  return { metadata, source };
}

export function yearFrom(date: string | null | undefined): number | null {
  const m = date ? /\b(1[4-9]\d\d|20\d\d)\b/.exec(date) : null;
  return m ? Number(m[1]) : null;
}

/** Field-by-field: `primary` wins wherever it has a value, `secondary` fills the gaps. */
export function fillMetadata(primary: BookMetadata, secondary: BookMetadata): BookMetadata {
  const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  const filled = Object.fromEntries(
    Object.entries(primary).map(([k, v]) => [k, isEmpty(v) ? secondary[k as keyof BookMetadata] : v]),
  ) as BookMetadata;
  return { ...filled, seriesIndex: primary.series ? filled.seriesIndex : secondary.seriesIndex };
}

/** How trustworthy each format's embedded metadata usually is (lower is better). */
export const FORMAT_METADATA_RANK: Record<BookFormat, number> = { epub: 0, fb2: 1, cbz: 2, cbr: 2, djvu: 3, pdf: 4 };
