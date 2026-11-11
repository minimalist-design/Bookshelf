import { splitAuthors } from "../naming/authors.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import type { BookFormat } from "../naming/formats.ts";
import type { ParsedFilename } from "../naming/parseFilename.ts";
import { emptyMetadata, type BookMetadata, type MetadataSource, type RawMetadata } from "../metadata/types.ts";
import { isJunkAuthor, isJunkTitle } from "./junk.ts";

export interface MergeResult {
  metadata: BookMetadata;
  source: MetadataSource;
}

function text(v: string | null | undefined): string | null {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/**
 * Field-level merge: each embedded value wins unless it is junk; empty fields are
 * filled from the filename. isbn13/doi found in the filename always win.
 */
export function mergeMetadata(embedded: RawMetadata, parsed: ParsedFilename, fileStem: string): MergeResult {
  let usedEmbedded = false;
  let usedFilename = false;

  const embTitle = text(embedded.title);
  let title: string;
  // An embedded title that merely repeats a *structured* filename ("T -- A -- isbn13 …") is junk;
  // a plain filename equal to the title ("dune.epub" / "Dune") is just a well-named file.
  if (embTitle && !isJunkTitle(embTitle, parsed.pattern === "plain" ? undefined : fileStem)) {
    title = embTitle;
    usedEmbedded = true;
  } else if (parsed.title) {
    title = parsed.title;
    usedFilename = true;
  } else {
    title = text(fileStem) ?? "Untitled";
    usedFilename = true;
  }

  const embAuthors = (embedded.authors ?? [])
    .flatMap((a) => splitAuthors(a))
    .filter((a) => !isJunkAuthor(a));
  let authors: string[] = [];
  if (embAuthors.length) {
    authors = embAuthors;
    usedEmbedded = true;
  } else if (parsed.authors.length) {
    authors = parsed.authors;
    usedFilename = true;
  }

  const m = emptyMetadata(title);
  m.authors = authors;
  m.isbn13 = parsed.isbn13 ?? normalizeIsbn(embedded.isbn13);
  m.doi = parsed.doi ?? normalizeDoi(embedded.doi);
  if (parsed.isbn13 || parsed.doi) usedFilename = true;
  if ((!parsed.isbn13 && m.isbn13) || (!parsed.doi && m.doi)) usedEmbedded = true;

  m.subtitle = text(embedded.subtitle);
  m.publisher = text(embedded.publisher);
  m.publishedDate = text(embedded.publishedDate);
  m.year = embedded.year ?? yearFrom(m.publishedDate);
  m.language = text(embedded.language);
  m.pages = embedded.pages && embedded.pages > 0 ? Math.round(embedded.pages) : null;
  m.description = text(embedded.description);
  m.series = text(embedded.series);
  m.seriesIndex = m.series && embedded.seriesIndex != null && Number.isFinite(embedded.seriesIndex) ? embedded.seriesIndex : null;
  m.tags = dedupe((embedded.tags ?? []).map((t) => text(t)).filter((t): t is string => !!t && t.length <= 64));
  if (m.subtitle || m.publisher || m.description || m.series || m.tags.length) usedEmbedded = true;

  const source: MetadataSource = usedEmbedded && usedFilename ? "mixed" : usedEmbedded ? "embedded" : "filename";
  return { metadata: m, source };
}

export function yearFrom(date: string | null | undefined): number | null {
  const m = date ? /\b(1[4-9]\d\d|20\d\d)\b/.exec(date) : null;
  return m ? Number(m[1]) : null;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Field-by-field: `primary` wins wherever it has a value, `secondary` fills the gaps. */
export function fillMetadata(primary: BookMetadata, secondary: BookMetadata): BookMetadata {
  const pick = <K extends keyof BookMetadata>(k: K): BookMetadata[K] => {
    const a = primary[k];
    const empty = a === null || a === undefined || a === "" || (Array.isArray(a) && a.length === 0);
    return empty ? secondary[k] : a;
  };
  const out = { ...primary };
  for (const k of Object.keys(primary) as (keyof BookMetadata)[]) (out as Record<string, unknown>)[k] = pick(k);
  if (!primary.series) out.seriesIndex = secondary.seriesIndex;
  return out;
}

/** How trustworthy each format's embedded metadata usually is (lower is better). */
export const FORMAT_METADATA_RANK: Record<BookFormat, number> = { epub: 0, fb2: 1, cbz: 2, cbr: 2, djvu: 3, pdf: 4 };
