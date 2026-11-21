/** Normalized book metadata as stored in the DB. */
export interface BookMetadata {
  readonly title: string;
  readonly subtitle: string | null;
  readonly authors: readonly string[];
  readonly isbn13: string | null;
  readonly doi: string | null;
  readonly publisher: string | null;
  /** Free-text edition statement ("2", "2nd", "Revised"…). */
  readonly edition: string | null;
  readonly publishedDate: string | null;
  readonly year: number | null;
  readonly language: string | null;
  readonly pages: number | null;
  readonly description: string | null;
  readonly series: string | null;
  readonly seriesIndex: number | null;
  readonly tags: readonly string[];
}

/** A cover image's bytes, in whatever format they came; the cover store identifies it. */
export interface CoverImage {
  readonly data: Uint8Array;
}

/** What an extractor found embedded in a file. Every field optional. */
export type RawMetadata = Partial<Omit<BookMetadata, "authors" | "tags">> & {
  authors?: string[];
  tags?: string[];
  /** Lazily produce the cover (may render a page); only called when a cover is actually needed. */
  loadCover?: () => Promise<CoverImage | null>;
};

export type MetadataSource = "embedded" | "filename" | "mixed";

export function emptyMetadata(title: string): BookMetadata {
  return {
    title,
    subtitle: null,
    authors: [],
    isbn13: null,
    doi: null,
    publisher: null,
    edition: null,
    publishedDate: null,
    year: null,
    language: null,
    pages: null,
    description: null,
    series: null,
    seriesIndex: null,
    tags: [],
  };
}

/** Just the metadata fields of a record that has more (e.g. a stored book). */
export function pickMetadata(m: BookMetadata): BookMetadata {
  return {
    title: m.title,
    subtitle: m.subtitle,
    authors: m.authors,
    isbn13: m.isbn13,
    doi: m.doi,
    publisher: m.publisher,
    edition: m.edition,
    publishedDate: m.publishedDate,
    year: m.year,
    language: m.language,
    pages: m.pages,
    description: m.description,
    series: m.series,
    seriesIndex: m.seriesIndex,
    tags: m.tags,
  };
}
