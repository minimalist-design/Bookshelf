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
  /** True when `library_root` is set in the config file; the root cannot be changed through the API. */
  libraryRootFromConfig: boolean;
  contactEmail: string | null;
  dataDir: string;
  tools: ExternalToolsStatus;
  /** ISBNdb is used (an API key is set in the environment), with the limits from the config file. */
  isbndb: { configured: boolean; dailyLimit: number; perSecond: number };
}

/** The plan behind the ISBNdb key and today's quota, as ISBNdb reports it. */
export interface IsbndbKeyDto {
  planName: string;
  bulkLimit: number;
  total: number;
  spent: number;
  left: number;
}

export interface SettingsUpdate {
  /** `null` unlinks the library (nothing on disk is touched). */
  libraryRoot?: string | null;
  /** Create `libraryRoot` (and missing parents) when it does not exist yet. */
  createLibraryRoot?: boolean;
  contactEmail?: string | null;
}

export interface ApiError {
  error: string;
}

// ---- Library ------------------------------------------------------------------

export type BookFormat = "epub" | "pdf" | "cbz" | "cbr" | "djvu" | "fb2";
export type ConfirmedSource = "isbndb" | "openlibrary" | "doi" | "manual";
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
}

export interface BookDetailDto extends BookSummaryDto {
  publisher: string | null;
  /** Free-text edition statement; a bare number means "Nth edition" (see formatEdition). */
  edition: string | null;
  publishedDate: string | null;
  language: string | null;
  pages: number | null;
  description: string | null;
  notes: string | null;
  olEditionKey: string | null;
  olWorkKey: string | null;
  confirmedAt: string | null;
  updatedAt: string;
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
  /** A metadata lookup was queued for the new book (`lookup=1` on upload). */
  lookupQueued: boolean;
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
  edition?: string | null;
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

export const LOOKUP_SOURCES = ["isbndb", "openlibrary", "doi"] as const;
export type LookupSource = (typeof LOOKUP_SOURCES)[number];

export const METADATA_FIELDS = [
  "title",
  "subtitle",
  "authors",
  "isbn13",
  "doi",
  "publisher",
  "edition",
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
  edition: string | null;
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
  /** DOI records only: the work's type as the registry gives it (Crossref `journal-article`, CSL `article-journal`, …). */
  workType?: string | null;
  /** Read from the kept copy of ISBNdb records: no call was made for it. */
  kept?: boolean;
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
  /** The book's own notes: local only, never part of a source's metadata, but editable while reviewing. */
  notes: string | null;
  candidates: CandidateWithDiff[];
  /** Problems talking to a source (network errors etc.). */
  errors: string[];
}

/** One cover image of an Open Library edition (or work), for picking a cover without touching the other metadata. */
export interface CoverOption {
  coverUrl: string;
  /** Open Library page of the edition (or of the work, for search results). */
  url: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  /** Short description, e.g. "Ace Books · Ace ed. · 1987 · 535 pages · Paperback". */
  details: string;
  /** ISO 639-1 code when known. */
  language: string | null;
  isbn13: string | null;
  /** The book's own edition (same ISBN). */
  thisEdition: boolean;
}

export interface CoverSearchResult {
  bookId: number;
  options: CoverOption[];
  /** Problems talking to a source (network errors etc.). */
  errors: string[];
}

export interface ApplyMetadataRequest {
  candidate: MetadataCandidate;
  fields: MetadataField[];
  /** Download and use the candidate's cover. */
  cover: boolean;
  /**
   * Values typed into the "Current" column, for fields not taken from the candidate.
   * Unlike candidate values, an edit can clear a field (`null`, or `[]` for lists).
   */
  edits?: Partial<Pick<BookUpdate, MetadataField | "notes">>;
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
  /** While a service is rate-limiting us: when the queue resumes (ISO time) and which service. */
  pausedUntil: string | null;
  pausedBy: string | null;
  /** The queue waits for the library to finish scanning (or to become available). */
  waitingForLibrary: boolean;
  /** Rough time left for the pending books, from the pace of this run; null until known. */
  etaSeconds: number | null;
  /** The book being looked up right now. */
  currentBookId: number | null;
}

export type LookupJobState = "pending" | "done" | "no_match" | "failed";

/** A book's bulk-lookup job; `position` is the number of pending jobs ahead of it. */
export interface LookupJobDto {
  state: LookupJobState;
  position: number;
  error: string | null;
}

/** Requests sent to one metadata service (cache hits are not counted). */
export interface MetadataServiceUsage {
  host: string;
  name: string;
  /** Since the `since` time of the request. */
  calls: number;
  lastHour: number;
  /** Published limit (requests per second) for the current identification; null when none is published. */
  perSecond: number | null;
  hourLimit: number | null;
  /** Set while the service is rate-limiting us (ISO time). */
  coolingDownUntil: string | null;
  /** Calls allowed per UTC day, for services with a daily quota (ISBNdb); null otherwise. */
  dailyLimit: number | null;
  /** Calls charged today (since 00:00 UTC) by our own count; a bulk call counts once per ISBN. */
  today: number;
  /** What the service last reported as left today (it also counts calls made elsewhere with the same key). */
  reportedLeft: number | null;
  /** When the daily quota resets (ISO time), for services with one. */
  quotaResetsAt: string | null;
}

export interface MetadataUsageDto {
  /** Server time (epoch ms); clients use it as their session start. */
  now: number;
  /** A contact email is set, which raises some limits. */
  identified: boolean;
  services: MetadataServiceUsage[];
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

/** An imported reference file (`/api/reference`). */
export interface ReferenceSourceDto {
  source: string;
  /** Display name, e.g. "Wikidata". */
  name: string;
  url: string | null;
  /** Which state of the source the file reflects (e.g. the date its build started). */
  version: string | null;
  builtAt: string | null;
  importedAt: string | null;
  /** Language codes kept for names and titles, comma-separated; "*" for all. */
  languages: string | null;
  license: string | null;
  counts: { authors: number; works: number; series: number; editions: number };
  bytes: number;
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
  /** ISBNdb records kept for good (never cleared with the lookup cache). */
  isbndbRecords: number;
  /** Their cover images downloaded so far, and their size. */
  isbndbCovers: number;
  isbndbCoverBytes: number;
  coverFiles: number;
  coverBytes: number;
  orphanCoverFiles: number;
  databaseBytes: number;
}

export interface CleanupResult {
  removedBooks: number;
  removedCoverFiles: number;
}

/** Books whose unconfirmed metadata the built-in metadata rules changed. */
export interface MetadataRulesResult {
  changed: number;
}

// ---- Name cleanup (merging spelling variants) ------------------------------------------

export const CLEANUP_FIELDS = ["authors", "tags", "series", "publishers"] as const;
export type CleanupField = (typeof CLEANUP_FIELDS)[number];

/** How a variant relates to its group's main name, strongest first; `similar` = only through another variant. */
export type NameMatchKind = "main" | "case" | "punctuation" | "typo" | "initials" | "similar";

export interface NameVariantDto {
  name: string;
  /** Books on disk with this spelling. */
  books: number;
  match: NameMatchKind;
  /** Ticked when the list first appears (the main name and safe matches). */
  preselected: boolean;
}

export interface NameGroupDto {
  /** The most used spelling, offered as the name to merge into. */
  main: string;
  /** The main name first, then the variants, strongest match first. */
  variants: NameVariantDto[];
}

export interface NameGroupsDto {
  field: CleanupField;
  groups: NameGroupDto[];
  /** Names without variants (authors only, so a lone badly written name can be renamed). */
  singles: FacetDto[];
}

export interface NameMergeRequest {
  field: CleanupField;
  from: string[];
  to: string;
}

export interface NameMergeResult {
  /** Books whose metadata changed. */
  books: number;
  renamed: RenameResult[];
  errors: string[];
}

/** A book listed by name, linking to its page. */
export interface BookRefDto {
  id: number;
  title: string;
  authors: string[];
}

/** A book whose title and authors look swapped (title reads as a person's name, authors as a title). */
export interface SwapSuspectDto {
  id: number;
  title: string;
  authors: string[];
  /** Its files on disk, relative to the library. */
  files: string[];
  /** The suggested fix. */
  proposed: { title: string; authors: string[] };
  /** `filename`: its file's name, read again, gives the swapped fields; `swap`: the two fields exchanged. */
  basis: "filename" | "swap";
}

export interface TitleAuthorFix {
  id: number;
  title: string;
  authors: string[];
}

export interface TitleAuthorFixRequest {
  items: TitleAuthorFix[];
}

/** Where author names are looked up: Wikidata first, Open Library as the fallback. */
export type AuthorSource = "wikidata" | "openlibrary";

/** An author record found by name, to merge spellings into its name. */
export interface AuthorMatchDto {
  source: AuthorSource;
  /** Wikidata item ("Q36322") or Open Library author key ("OL21594A"). */
  key: string;
  name: string;
  /** "1775–1817", or null when unknown. */
  years: string | null;
  /** Wikidata's short description ("English novelist"). */
  description: string | null;
  /** Open Library only. */
  topWork: string | null;
  workCount: number | null;
  alternateNames: string[];
  /** Library authority records for this person (Library of Congress, GND, VIAF…), Wikidata only. */
  authorities: { name: string; url: string }[];
  url: string;
}

export interface AuthorSearchDto {
  /** The source the matches come from. */
  source: AuthorSource;
  matches: AuthorMatchDto[];
  /** Why Open Library was used instead of Wikidata, if it was a fallback. */
  note: string | null;
}

/** A remembered variant: new imports and lookups get `canonical` instead. */
export interface AliasDto {
  field: CleanupField;
  variant: string;
  canonical: string;
}
