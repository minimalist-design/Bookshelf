/** Normalized book metadata as stored in the DB. */
export interface BookMetadata {
  title: string;
  subtitle: string | null;
  authors: string[];
  isbn13: string | null;
  doi: string | null;
  publisher: string | null;
  publishedDate: string | null;
  year: number | null;
  language: string | null;
  pages: number | null;
  description: string | null;
  series: string | null;
  seriesIndex: number | null;
  tags: string[];
}

export interface CoverImage {
  data: Uint8Array;
  mime: string;
}

/** What an extractor found embedded in a file. Every field optional; values may still be junk. */
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
