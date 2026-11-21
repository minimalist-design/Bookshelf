import { uniqueCaseless } from "../collections.ts";
import { splitAuthors } from "../naming/authors.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import type { BookFormat } from "../naming/formats.ts";
import type { ParsedFilename } from "../naming/parseFilename.ts";
import type { BookMetadata, MetadataSource, RawMetadata } from "../metadata/types.ts";

export interface MergeResult {
  readonly metadata: BookMetadata;
  readonly source: MetadataSource;
}

function text(v: string | null | undefined): string | null {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/**
 * Field-level merge: every embedded value is taken as it is; the title and authors fall back to the filename
 * (a plain filename gives only its stem as the title). An ISBN or DOI in a Bookshelf-style filename wins.
 */
export function mergeMetadata(embedded: RawMetadata, parsed: ParsedFilename, fileStem: string): MergeResult {
  const embeddedTitle = text(embedded.title);
  const embeddedAuthors = (embedded.authors ?? []).flatMap((a) => splitAuthors(text(a)));
  const title = embeddedTitle ?? parsed.title ?? text(fileStem) ?? "Untitled";
  const authors = embeddedAuthors.length ? embeddedAuthors : parsed.authors;
  const publishedDate = text(embedded.publishedDate);
  const series = text(embedded.series);
  const metadata: BookMetadata = {
    title,
    subtitle: text(embedded.subtitle),
    authors,
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

  const usedFilename = embeddedTitle === null || (!embeddedAuthors.length && authors.length > 0) || !!(parsed.isbn13 || parsed.doi);
  const usedEmbedded =
    embeddedTitle !== null ||
    embeddedAuthors.length > 0 ||
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
export const FORMAT_METADATA_RANK: Record<BookFormat, number> = { epub: 0, cbz: 1, cbr: 1, djvu: 2, pdf: 3 };
