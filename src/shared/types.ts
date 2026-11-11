// DTOs shared between server and web.

export interface ExternalToolsStatus {
  sevenZip: boolean;
  unrar: boolean;
  djvused: boolean;
  ddjvu: boolean;
  pdftoppm: boolean;
}

export interface SettingsDto {
  libraryRoot: string | null;
  /** True when BOOKSHELF_LIBRARY_ROOT is set; the root cannot be changed from the UI. */
  libraryRootFromEnv: boolean;
  contactEmail: string | null;
  dataDir: string;
  tools: ExternalToolsStatus;
}

export interface SettingsUpdate {
  libraryRoot?: string;
  contactEmail?: string | null;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

export interface ApiError {
  error: string;
}

// ---- Library ------------------------------------------------------------------

export type BookFormat = "epub" | "pdf" | "cbz" | "cbr" | "djvu" | "fb2";
export type ConfirmedSource = "openlibrary" | "doi" | "manual";
export type MetadataSource = "embedded" | "filename" | "mixed";

export interface BookFileDto {
  hash: string;
  relPath: string;
  filename: string;
  /** null = Unshelved (directly in the library root). */
  shelf: string | null;
  format: BookFormat;
  size: number;
  mtimeMs: number;
}

export interface BookSummaryDto {
  id: number;
  title: string;
  subtitle: string | null;
  authors: string[];
  year: number | null;
  series: string | null;
  seriesIndex: number | null;
  isbn13: string | null;
  doi: string | null;
  rating: number | null;
  tags: string[];
  hasCover: boolean;
  metadataSource: MetadataSource | null;
  confirmedSource: ConfirmedSource | null;
  createdAt: string;
  files: BookFileDto[];
  shelves: (string | null)[];
  /** Reading progress 0..1, when the book has been opened in the reader. */
  progress: number | null;
}

export interface BookDetailDto extends BookSummaryDto {
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  pages: number | null;
  description: string | null;
  notes: string | null;
  olEditionKey: string | null;
  olWorkKey: string | null;
  confirmedAt: string | null;
  readingPosition: ReadingPosition | null;
  updatedAt: string;
}

/** Where the reader left off, per book (the file it was read in + a format-specific locator). */
export interface ReadingPosition {
  /** Content hash of the file being read. */
  hash: string;
  /** EPUB: CFI · PDF/comics/DJVU: 1-based page number. */
  position: string;
  /** 0..1 when known. */
  fraction: number | null;
  updatedAt: string;
}

export interface PagesDto {
  count: number;
}

export type LibrarySort = "title" | "author" | "added" | "year" | "series" | "rating";

/** Filter for books lacking something (to find metadata that needs attention). */
export type MissingFilter = "id" | "author" | "cover" | "description";

export interface LibraryQuery {
  /** Omitted = all shelves; "" = Unshelved; otherwise a shelf name. */
  shelf?: string;
  q?: string;
  format?: BookFormat;
  tag?: string;
  series?: string;
  author?: string;
  /** true = only confirmed metadata, false = only unconfirmed. */
  confirmed?: boolean;
  missing?: MissingFilter;
  minRating?: number;
  sort?: LibrarySort;
  order?: "asc" | "desc";
  page?: number;
  size?: number;
}

export interface LibraryPage {
  items: BookSummaryDto[];
  total: number;
  page: number;
  size: number;
}

export interface ShelfDto {
  /** null = Unshelved. */
  name: string | null;
  bookCount: number;
}

export type LibraryState = "no-root" | "scanning" | "ready" | "unavailable";

export interface LibraryStatus {
  state: LibraryState;
  root: string | null;
  scan: { done: number; total: number } | null;
  fileCount: number;
  bookCount: number;
  watching: boolean;
  message: string | null;
}

export type ServerEvent =
  | { type: "library.changed"; bookIds: number[] }
  | { type: "library.status"; status: LibraryStatus }
  | { type: "lookup.status"; status: LookupQueueStatus };

// ---- Import -------------------------------------------------------------------

/** Extensions accepted for upload (lowercase, with leading dot). */
export const SUPPORTED_EXTENSIONS = [".epub", ".pdf", ".cbz", ".cbr", ".djvu", ".djv", ".fb2", ".fb2.zip", ".fbz"] as const;

/**
 * imported: new book · attached: new format of an existing book · reconnected: kept (confirmed)
 * metadata without files got its file back · duplicate: rejected, the library already has it.
 */
export type ImportStatus = "imported" | "attached" | "reconnected" | "duplicate";

export interface ImportResultDto {
  status: ImportStatus;
  bookId: number;
  title: string;
  authors: string[];
  format: BookFormat;
  /** Where the file now lives (for duplicates: the existing file). */
  relPath: string | null;
  shelf: string | null;
  message: string;
}

// ---- Editing ------------------------------------------------------------------

/** Partial update of a book; omitted fields are left unchanged, null clears a field. */
export interface BookUpdate {
  title?: string;
  subtitle?: string | null;
  authors?: string[];
  isbn13?: string | null;
  doi?: string | null;
  publisher?: string | null;
  publishedDate?: string | null;
  language?: string | null;
  pages?: number | null;
  description?: string | null;
  series?: string | null;
  seriesIndex?: number | null;
  tags?: string[];
  rating?: number | null;
  notes?: string | null;
}

export interface RenameResult {
  from: string;
  to: string;
}

export interface BookActionResult {
  book: BookDetailDto;
  renamed: RenameResult[];
  /** Files that could not be renamed (permissions etc.); the edit itself succeeded. */
  errors: string[];
}

export interface BulkRenameResult {
  renamed: RenameResult[];
  errors: string[];
}

export interface FacetDto {
  name: string;
  count: number;
}

/** Values present among the books currently on disk (for filters and autocomplete). */
export interface LibraryFacets {
  tags: FacetDto[];
  series: FacetDto[];
  authors: FacetDto[];
  formats: FacetDto[];
  languages: FacetDto[];
  publishers: FacetDto[];
}

// ---- Shelves, moving and deleting --------------------------------------------------

export interface ShelfDeleteResult {
  /** Book files moved to the library root (Unshelved). */
  moved: RenameResult[];
}

/** 409 details when a shelf cannot be deleted. */
export interface ShelfDeleteConflict {
  files: string[];
  total: number;
}

export interface MoveResult {
  moved: RenameResult[];
  errors: string[];
}

export interface DeleteResult {
  deletedFiles: string[];
  /** Books whose last file was deleted but whose confirmed metadata is kept. */
  keptMetadata: number[];
  /** Books whose (unconfirmed) metadata was removed together with their last file. */
  removedMetadata: number[];
  errors: string[];
}

// ---- External metadata lookups ----------------------------------------------------

export type LookupSource = "openlibrary" | "doi";

export const METADATA_FIELDS = [
  "title",
  "subtitle",
  "authors",
  "isbn13",
  "doi",
  "publisher",
  "publishedDate",
  "language",
  "pages",
  "description",
  "series",
  "seriesIndex",
  "tags",
] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

export interface CandidateMetadata {
  title: string | null;
  subtitle: string | null;
  authors: string[];
  isbn13: string | null;
  doi: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  pages: number | null;
  description: string | null;
  series: string | null;
  seriesIndex: number | null;
  tags: string[];
}

export interface MetadataCandidate {
  source: LookupSource;
  /** How it was found: by the book's identifier (reliable) or by a title/author search. */
  match: "isbn" | "doi" | "search";
  /** Open Library edition/work key or the DOI. */
  id: string;
  /** Page for a human to check the record. */
  url: string;
  /** Short description, e.g. "Ace · 2020 · 896 pages". */
  label: string;
  metadata: CandidateMetadata;
  coverUrl: string | null;
  olEditionKey: string | null;
  olWorkKey: string | null;
}

/** same: equal · fill: book is empty here · conflict: both differ · missing: candidate has nothing. */
export type DiffStatus = "same" | "fill" | "conflict" | "missing";

export interface FieldDiff {
  field: MetadataField;
  current: string | number | string[] | null;
  candidate: string | number | string[] | null;
  status: DiffStatus;
}

export interface CandidateWithDiff extends MetadataCandidate {
  diff: FieldDiff[];
}

export interface LookupResult {
  bookId: number;
  candidates: CandidateWithDiff[];
  /** Problems talking to a source (network errors etc.). */
  errors: string[];
}

export interface ApplyMetadataRequest {
  candidate: MetadataCandidate;
  fields: MetadataField[];
  /** Download and use the candidate's cover. */
  cover: boolean;
}

export interface ReviewItemDto {
  book: BookSummaryDto;
  result: LookupResult;
  createdAt: string;
}

export interface LookupQueueStatus {
  running: boolean;
  /** Books waiting to be looked up. */
  pending: number;
  /** Looked up in the current run. */
  done: number;
  /** Lookups that failed (network/service errors) in the current run. */
  failed: number;
  /** Lookups without any candidate in the current run. */
  noMatch: number;
  /** Items waiting in the review queue. */
  reviewCount: number;
}

// ---- Maintenance ----------------------------------------------------------------

/** Metadata row whose files are not on disk (kept because it is confirmed, or pending cleanup). */
export interface MissingBookDto {
  id: number;
  title: string;
  authors: string[];
  isbn13: string | null;
  doi: string | null;
  confirmedSource: ConfirmedSource | null;
  hasCover: boolean;
  /** Formats of the file versions known by content hash. */
  formats: BookFormat[];
  updatedAt: string;
}

export interface MaintenanceStats {
  booksOnDisk: number;
  filesOnDisk: number;
  metadataRows: number;
  confirmed: number;
  missing: number;
  missingUnconfirmed: number;
  reviewQueue: number;
  hashCacheEntries: number;
  httpCacheEntries: number;
  coverFiles: number;
  coverBytes: number;
  orphanCoverFiles: number;
  databaseBytes: number;
}

export interface CleanupResult {
  removedBooks: number;
  removedCoverFiles: number;
}
