// Types of the HTTP API and its events (see docs/api.md). Every field is readonly: values are built once, never changed.

export interface ExternalToolsStatus {
  readonly sevenZip: boolean;
  readonly unrar: boolean;
  readonly djvused: boolean;
  readonly ddjvu: boolean;
  readonly pdftoppm: boolean;
}

export interface SettingsDto {
  readonly libraryRoot: string | null;
  /** True when `library_root` is set in the config file; the root cannot be changed through the API. */
  readonly libraryRootFromConfig: boolean;
  readonly contactEmail: string | null;
  readonly dataDir: string;
  readonly tools: ExternalToolsStatus;
  /** ISBNdb is used (an API key is set in the environment), with the limits from the config file. */
  readonly isbndb: { readonly configured: boolean; readonly dailyLimit: number; readonly perSecond: number };
}

/** The plan behind the ISBNdb key and today's quota, as ISBNdb reports it. */
export interface IsbndbKeyDto {
  readonly planName: string;
  readonly bulkLimit: number;
  readonly total: number;
  readonly spent: number;
  readonly left: number;
}

export interface SettingsUpdate {
  /** `null` unlinks the library (nothing on disk is touched). */
  readonly libraryRoot?: string | null;
  /** Create `libraryRoot` (and missing parents) when it does not exist yet. */
  readonly createLibraryRoot?: boolean;
  readonly contactEmail?: string | null;
}

export interface ApiError {
  readonly error: string;
}

// ---- Library ------------------------------------------------------------------

export type BookFormat = "epub" | "pdf" | "cbz" | "cbr" | "djvu" | "fb2";
export type ConfirmedSource = "isbndb" | "openlibrary" | "doi" | "manual";
export type MetadataSource = "embedded" | "filename" | "mixed";

export interface BookFileDto {
  readonly hash: string;
  readonly relPath: string;
  readonly filename: string;
  /** null = Unshelved (directly in the library root). */
  readonly shelf: string | null;
  readonly format: BookFormat;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface BookSummaryDto {
  readonly id: number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly authors: readonly string[];
  readonly year: number | null;
  readonly series: string | null;
  readonly seriesIndex: number | null;
  readonly isbn13: string | null;
  readonly doi: string | null;
  readonly rating: number | null;
  readonly tags: readonly string[];
  readonly hasCover: boolean;
  readonly metadataSource: MetadataSource | null;
  readonly confirmedSource: ConfirmedSource | null;
  readonly createdAt: string;
  readonly files: readonly BookFileDto[];
  readonly shelves: readonly (string | null)[];
}

export interface BookDetailDto extends BookSummaryDto {
  readonly publisher: string | null;
  /** Free-text edition statement; a bare number means "Nth edition" (see formatEdition). */
  readonly edition: string | null;
  readonly publishedDate: string | null;
  readonly language: string | null;
  readonly pages: number | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly olEditionKey: string | null;
  readonly olWorkKey: string | null;
  readonly confirmedAt: string | null;
  readonly updatedAt: string;
}

export type LibrarySort = "title" | "author" | "added" | "year" | "series" | "rating";

/** Filter for books lacking something (to find metadata that needs attention). */
export type MissingFilter = "id" | "author" | "cover" | "description";

export interface LibraryQuery {
  /** Omitted = all shelves; "" = Unshelved; otherwise a shelf name. */
  readonly shelf?: string;
  readonly q?: string;
  readonly format?: BookFormat;
  readonly tag?: string;
  readonly series?: string;
  readonly author?: string;
  /** true = only confirmed metadata, false = only unconfirmed. */
  readonly confirmed?: boolean;
  readonly missing?: MissingFilter;
  readonly minRating?: number;
  readonly sort?: LibrarySort;
  readonly order?: "asc" | "desc";
  readonly page?: number;
  readonly size?: number;
}

export interface LibraryPage {
  readonly items: readonly BookSummaryDto[];
  readonly total: number;
  readonly page: number;
  readonly size: number;
}

export interface ShelfDto {
  /** null = Unshelved. */
  readonly name: string | null;
  readonly bookCount: number;
}

export type LibraryState = "no-root" | "scanning" | "ready" | "unavailable";

export interface LibraryStatus {
  readonly state: LibraryState;
  readonly root: string | null;
  readonly scan: { readonly done: number; readonly total: number } | null;
  readonly fileCount: number;
  readonly bookCount: number;
  readonly watching: boolean;
  readonly message: string | null;
}

export type ServerEvent =
  | { readonly type: "library.changed"; readonly bookIds: readonly number[] }
  | { readonly type: "library.status"; readonly status: LibraryStatus }
  | { readonly type: "lookup.status"; readonly status: LookupQueueStatus };

// ---- Import -------------------------------------------------------------------

/** Extensions accepted for upload (lowercase, with leading dot). */
export const SUPPORTED_EXTENSIONS = [".epub", ".pdf", ".cbz", ".cbr", ".djvu", ".djv", ".fb2", ".fb2.zip", ".fbz"] as const;

/**
 * imported: new book · attached: new format of an existing book · reconnected: kept (confirmed)
 * metadata without files got its file back · duplicate: rejected, the library already has it.
 */
export type ImportStatus = "imported" | "attached" | "reconnected" | "duplicate";

export interface ImportResultDto {
  readonly status: ImportStatus;
  readonly bookId: number;
  readonly title: string;
  readonly authors: readonly string[];
  readonly format: BookFormat;
  /** Where the file now lives (for duplicates: the existing file). */
  readonly relPath: string | null;
  readonly shelf: string | null;
  readonly message: string;
  /** A metadata lookup was queued for the new book (`lookup=1` on upload). */
  readonly lookupQueued: boolean;
}

// ---- Editing ------------------------------------------------------------------

/** Partial update of a book; omitted fields are left unchanged, null clears a field. */
export interface BookUpdate {
  readonly title?: string;
  readonly subtitle?: string | null;
  readonly authors?: readonly string[];
  readonly isbn13?: string | null;
  readonly doi?: string | null;
  readonly publisher?: string | null;
  readonly edition?: string | null;
  readonly publishedDate?: string | null;
  readonly language?: string | null;
  readonly pages?: number | null;
  readonly description?: string | null;
  readonly series?: string | null;
  readonly seriesIndex?: number | null;
  readonly tags?: readonly string[];
  readonly rating?: number | null;
  readonly notes?: string | null;
}

export interface RenameResult {
  readonly from: string;
  readonly to: string;
}

export interface BookActionResult {
  readonly book: BookDetailDto;
  readonly renamed: readonly RenameResult[];
  /** Files that could not be renamed (permissions etc.); the edit itself succeeded. */
  readonly errors: readonly string[];
}

export interface BulkRenameResult {
  readonly renamed: readonly RenameResult[];
  readonly errors: readonly string[];
}

export interface FacetDto {
  readonly name: string;
  readonly count: number;
}

/** Values present among the books currently on disk (for filters and autocomplete). */
export interface LibraryFacets {
  readonly tags: readonly FacetDto[];
  readonly series: readonly FacetDto[];
  readonly authors: readonly FacetDto[];
  readonly formats: readonly FacetDto[];
  readonly languages: readonly FacetDto[];
  readonly publishers: readonly FacetDto[];
}

// ---- Shelves, moving and deleting --------------------------------------------------

export interface ShelfDeleteResult {
  /** Book files moved to the library root (Unshelved). */
  readonly moved: readonly RenameResult[];
}

/** 409 details when a shelf cannot be deleted. */
export interface ShelfDeleteConflict {
  readonly files: readonly string[];
  readonly total: number;
}

export interface MoveResult {
  readonly moved: readonly RenameResult[];
  readonly errors: readonly string[];
}

export interface DeleteResult {
  readonly deletedFiles: readonly string[];
  /** Books whose last file was deleted but whose confirmed metadata is kept. */
  readonly keptMetadata: readonly number[];
  /** Books whose (unconfirmed) metadata was removed together with their last file. */
  readonly removedMetadata: readonly number[];
  readonly errors: readonly string[];
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
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly authors: readonly string[];
  readonly isbn13: string | null;
  readonly doi: string | null;
  readonly publisher: string | null;
  readonly edition: string | null;
  readonly publishedDate: string | null;
  readonly language: string | null;
  readonly pages: number | null;
  readonly description: string | null;
  readonly series: string | null;
  readonly seriesIndex: number | null;
  readonly tags: readonly string[];
}

export interface MetadataCandidate {
  readonly source: LookupSource;
  /** How it was found: by the book's identifier (reliable) or by a title/author search. */
  readonly match: "isbn" | "doi" | "search";
  /** Open Library edition/work key or the DOI. */
  readonly id: string;
  /** Page for a human to check the record. */
  readonly url: string;
  /** Short description, e.g. "Ace · 2020 · 896 pages". */
  readonly label: string;
  readonly metadata: CandidateMetadata;
  readonly coverUrl: string | null;
  readonly olEditionKey: string | null;
  readonly olWorkKey: string | null;
  /** DOI records only: the work's type as the registry gives it (Crossref `journal-article`, CSL `article-journal`, …). */
  readonly workType?: string | null;
  /** Read from the kept copy of ISBNdb records: no call was made for it. */
  readonly kept?: boolean;
}

/** same: equal · fill: book is empty here · conflict: both differ · missing: candidate has nothing. */
export type DiffStatus = "same" | "fill" | "conflict" | "missing";

export interface FieldDiff {
  readonly field: MetadataField;
  readonly current: string | number | readonly string[] | null;
  readonly candidate: string | number | readonly string[] | null;
  readonly status: DiffStatus;
}

export interface CandidateWithDiff extends MetadataCandidate {
  readonly diff: readonly FieldDiff[];
}

export interface LookupResult {
  readonly bookId: number;
  /** The book's own notes: local only, never part of a source's metadata, but editable while reviewing. */
  readonly notes: string | null;
  readonly candidates: readonly CandidateWithDiff[];
  /** Problems talking to a source (network errors etc.). */
  readonly errors: readonly string[];
}

/** One cover image of an Open Library edition (or work), for picking a cover without touching the other metadata. */
export interface CoverOption {
  readonly coverUrl: string;
  /** Open Library page of the edition (or of the work, for search results). */
  readonly url: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly authors: readonly string[];
  /** Short description, e.g. "Ace Books · Ace ed. · 1987 · 535 pages · Paperback". */
  readonly details: string;
  /** ISO 639-1 code when known. */
  readonly language: string | null;
  readonly isbn13: string | null;
  /** The book's own edition (same ISBN). */
  readonly thisEdition: boolean;
}

export interface CoverSearchResult {
  readonly bookId: number;
  readonly options: readonly CoverOption[];
  /** Problems talking to a source (network errors etc.). */
  readonly errors: readonly string[];
}

export interface ApplyMetadataRequest {
  readonly candidate: MetadataCandidate;
  readonly fields: readonly MetadataField[];
  /** Download and use the candidate's cover. */
  readonly cover: boolean;
  /**
   * Values typed into the "Current" column, for fields not taken from the candidate.
   * Unlike candidate values, an edit can clear a field (`null`, or `[]` for lists).
   */
  readonly edits?: Partial<Pick<BookUpdate, MetadataField | "notes">>;
}

export interface ReviewItemDto {
  readonly book: BookSummaryDto;
  readonly result: LookupResult;
  readonly createdAt: string;
}

export interface LookupQueueStatus {
  readonly running: boolean;
  /** Books waiting to be looked up. */
  readonly pending: number;
  /** Looked up in the current run. */
  readonly done: number;
  /** Lookups that failed (network/service errors) in the current run. */
  readonly failed: number;
  /** Lookups without any candidate in the current run. */
  readonly noMatch: number;
  /** Items waiting in the review queue. */
  readonly reviewCount: number;
  /** While a service is rate-limiting us: when the queue resumes (ISO time) and which service. */
  readonly pausedUntil: string | null;
  readonly pausedBy: string | null;
  /** The queue waits for the library to finish scanning (or to become available). */
  readonly waitingForLibrary: boolean;
  /** Rough time left for the pending books, from the pace of this run; null until known. */
  readonly etaSeconds: number | null;
  /** The book being looked up right now. */
  readonly currentBookId: number | null;
}

export type LookupJobState = "pending" | "done" | "no_match" | "failed";

/** A book's bulk-lookup job; `position` is the number of pending jobs ahead of it. */
export interface LookupJobDto {
  readonly state: LookupJobState;
  readonly position: number;
  readonly error: string | null;
}

/** Requests sent to one metadata service (cache hits are not counted). */
export interface MetadataServiceUsage {
  readonly host: string;
  readonly name: string;
  /** Since the `since` time of the request. */
  readonly calls: number;
  readonly lastHour: number;
  /** Published limit (requests per second) for the current identification; null when none is published. */
  readonly perSecond: number | null;
  readonly hourLimit: number | null;
  /** Set while the service is rate-limiting us (ISO time). */
  readonly coolingDownUntil: string | null;
  /** Calls allowed per UTC day, for services with a daily quota (ISBNdb); null otherwise. */
  readonly dailyLimit: number | null;
  /** Calls charged today (since 00:00 UTC) by our own count; a bulk call counts once per ISBN. */
  readonly today: number;
  /** What the service last reported as left today (it also counts calls made elsewhere with the same key). */
  readonly reportedLeft: number | null;
  /** When the daily quota resets (ISO time), for services with one. */
  readonly quotaResetsAt: string | null;
}

export interface MetadataUsageDto {
  /** Server time (epoch ms); clients use it as their session start. */
  readonly now: number;
  /** A contact email is set, which raises some limits. */
  readonly identified: boolean;
  readonly services: readonly MetadataServiceUsage[];
}

// ---- Maintenance ----------------------------------------------------------------

/** Metadata row whose files are not on disk (kept because it is confirmed, or pending cleanup). */
export interface MissingBookDto {
  readonly id: number;
  readonly title: string;
  readonly authors: readonly string[];
  readonly isbn13: string | null;
  readonly doi: string | null;
  readonly confirmedSource: ConfirmedSource | null;
  readonly hasCover: boolean;
  /** Formats of the file versions known by content hash. */
  readonly formats: readonly BookFormat[];
  readonly updatedAt: string;
}

/** An imported reference file (`/api/reference`). */
export interface ReferenceSourceDto {
  readonly source: string;
  /** Display name, e.g. "Wikidata". */
  readonly name: string;
  readonly url: string | null;
  /** Which state of the source the file reflects (e.g. the date its build started). */
  readonly version: string | null;
  readonly builtAt: string | null;
  readonly importedAt: string | null;
  /** Language codes kept for names and titles, comma-separated; "*" for all. */
  readonly languages: string | null;
  readonly license: string | null;
  readonly counts: { readonly authors: number; readonly works: number; readonly series: number; readonly editions: number };
  readonly bytes: number;
}

export interface MaintenanceStats {
  readonly booksOnDisk: number;
  readonly filesOnDisk: number;
  readonly metadataRows: number;
  readonly confirmed: number;
  readonly missing: number;
  readonly missingUnconfirmed: number;
  readonly reviewQueue: number;
  readonly hashCacheEntries: number;
  readonly httpCacheEntries: number;
  /** ISBNdb records kept for good (never cleared with the lookup cache). */
  readonly isbndbRecords: number;
  /** Their cover images downloaded so far, and their size. */
  readonly isbndbCovers: number;
  readonly isbndbCoverBytes: number;
  readonly coverFiles: number;
  readonly coverBytes: number;
  readonly orphanCoverFiles: number;
  readonly databaseBytes: number;
}

export interface CleanupResult {
  readonly removedBooks: number;
  readonly removedCoverFiles: number;
}

/** Books whose unconfirmed metadata the built-in metadata rules changed. */
export interface MetadataRulesResult {
  readonly changed: number;
}

// ---- Name cleanup (merging spelling variants) ------------------------------------------

export const CLEANUP_FIELDS = ["authors", "tags", "series", "publishers"] as const;
export type CleanupField = (typeof CLEANUP_FIELDS)[number];

/** How a variant relates to its group's main name, strongest first; `similar` = only through another variant. */
export type NameMatchKind = "main" | "case" | "punctuation" | "typo" | "initials" | "similar";

export interface NameVariantDto {
  readonly name: string;
  /** Books on disk with this spelling. */
  readonly books: number;
  readonly match: NameMatchKind;
  /** Ticked when the list first appears (the main name and safe matches). */
  readonly preselected: boolean;
}

export interface NameGroupDto {
  /** The most used spelling, offered as the name to merge into. */
  readonly main: string;
  /** The main name first, then the variants, strongest match first. */
  readonly variants: readonly NameVariantDto[];
}

export interface NameGroupsDto {
  readonly field: CleanupField;
  readonly groups: readonly NameGroupDto[];
  /** Names without variants (authors only, so a lone badly written name can be renamed). */
  readonly singles: readonly FacetDto[];
}

export interface NameMergeRequest {
  readonly field: CleanupField;
  readonly from: readonly string[];
  readonly to: string;
}

export interface NameMergeResult {
  /** Books whose metadata changed. */
  readonly books: number;
  readonly renamed: readonly RenameResult[];
  readonly errors: readonly string[];
}

/** A book listed by name, linking to its page. */
export interface BookRefDto {
  readonly id: number;
  readonly title: string;
  readonly authors: readonly string[];
}

/** A book whose title and authors look swapped (title reads as a person's name, authors as a title). */
export interface SwapSuspectDto {
  readonly id: number;
  readonly title: string;
  readonly authors: readonly string[];
  /** Its files on disk, relative to the library. */
  readonly files: readonly string[];
  /** The suggested fix. */
  readonly proposed: { readonly title: string; readonly authors: readonly string[] };
  /** `filename`: its file's name, read again, gives the swapped fields; `swap`: the two fields exchanged. */
  readonly basis: "filename" | "swap";
}

export interface TitleAuthorFix {
  readonly id: number;
  readonly title: string;
  readonly authors: readonly string[];
}

export interface TitleAuthorFixRequest {
  readonly items: readonly TitleAuthorFix[];
}

/** Where author names are looked up: Wikidata first, Open Library as the fallback. */
export type AuthorSource = "wikidata" | "openlibrary";

/** An author record found by name, to merge spellings into its name. */
export interface AuthorMatchDto {
  readonly source: AuthorSource;
  /** Wikidata item ("Q36322") or Open Library author key ("OL21594A"). */
  readonly key: string;
  readonly name: string;
  /** "1775–1817", or null when unknown. */
  readonly years: string | null;
  /** Wikidata's short description ("English novelist"). */
  readonly description: string | null;
  /** Open Library only. */
  readonly topWork: string | null;
  readonly workCount: number | null;
  readonly alternateNames: readonly string[];
  /** Library authority records for this person (Library of Congress, GND, VIAF…), Wikidata only. */
  readonly authorities: readonly { readonly name: string; readonly url: string }[];
  readonly url: string;
}

export interface AuthorSearchDto {
  /** The source the matches come from. */
  readonly source: AuthorSource;
  readonly matches: readonly AuthorMatchDto[];
  /** Why Open Library was used instead of Wikidata, if it was a fallback. */
  readonly note: string | null;
}

/** A remembered variant: new imports and lookups get `canonical` instead. */
export interface AliasDto {
  readonly field: CleanupField;
  readonly variant: string;
  readonly canonical: string;
}
