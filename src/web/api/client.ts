import type {
  AliasDto,
  AuthorSearchDto,
  AuthorSource,
  CleanupField,
  NameGroupsDto,
  NameMergeRequest,
  NameMergeResult,
  SwapSuspectDto,
  BookRefDto,
  IsbndbKeyDto,
  MetadataRulesResult,
  TitleAuthorFixRequest,
  CleanupResult,
  MaintenanceStats,
  MissingBookDto,
  ReferenceSourceDto,
  PagesDto,
  ReadingPosition,
  ApplyMetadataRequest,
  CoverSearchResult,
  LookupJobDto,
  LookupQueueStatus,
  LookupResult,
  MetadataUsageDto,
  LookupSource,
  ReviewItemDto,
  DeleteResult,
  MoveResult,
  ShelfDeleteResult,
  BookActionResult,
  BookUpdate,
  BulkRenameResult,
  LibraryFacets,
  ImportResultDto,
  BookDetailDto,
  BrowseResult,
  LibraryPage,
  LibraryQuery,
  LibraryStatus,
  SettingsDto,
  SettingsUpdate,
  ShelfDto,
} from "../../shared/types.ts";

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: typeof init?.body === "string" ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new ApiRequestError(body?.error ?? res.statusText, res.status, body?.details);
  return body as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const api = {
  getSettings: () => request<SettingsDto>("/api/settings"),
  updateSettings: (update: SettingsUpdate) =>
    request<SettingsDto>("/api/settings", { method: "PUT", body: JSON.stringify(update) }),
  browse: (path?: string) => request<BrowseResult>(`/api/fs/browse${qs({ path })}`),
  mkdir: (parent: string, name: string) =>
    request<{ path: string }>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ parent, name }) }),
  getLibrary: (q: LibraryQuery) =>
    request<LibraryPage>(
      `/api/library${qs({
        shelf: q.shelf,
        q: q.q || undefined,
        format: q.format,
        tag: q.tag,
        series: q.series,
        author: q.author,
        confirmed: q.confirmed === undefined ? undefined : String(q.confirmed),
        missing: q.missing,
        minRating: q.minRating,
        sort: q.sort,
        order: q.order,
        page: q.page,
        size: q.size,
      })}`,
    ),
  getFacets: () => request<LibraryFacets>("/api/facets"),
  updateBook: (id: number, update: BookUpdate) =>
    request<BookActionResult>(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify(update) }),
  normalizeFilenames: (ids: number[]) =>
    request<BulkRenameResult>("/api/books/normalize-filenames", { method: "POST", body: JSON.stringify({ ids }) }),
  mergeBooks: (sourceId: number, intoId: number) =>
    request<BookActionResult>(`/api/books/${sourceId}/merge`, { method: "POST", body: JSON.stringify({ intoId }) }),
  detachFile: (bookId: number, hash: string) =>
    request<BookActionResult>(`/api/books/${bookId}/files/${hash}/detach`, { method: "POST" }),
  setCover: (id: number, file: Blob) => request<BookDetailDto>(`/api/books/${id}/cover`, { method: "PUT", body: file }),
  createShelf: (name: string) => request<ShelfDto>("/api/shelves", { method: "POST", body: JSON.stringify({ name }) }),
  renameShelf: (name: string, newName: string) =>
    request<ShelfDto>(`/api/shelves/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ name: newName }) }),
  deleteShelf: (name: string) => request<ShelfDeleteResult>(`/api/shelves/${encodeURIComponent(name)}`, { method: "DELETE" }),
  moveBooks: (ids: number[], shelf: string | null) =>
    request<MoveResult>("/api/books/move", { method: "POST", body: JSON.stringify({ ids, shelf }) }),
  deleteBooks: (ids: number[]) => request<DeleteResult>("/api/books/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  deleteFile: (bookId: number, hash: string) => request<DeleteResult>(`/api/books/${bookId}/files/${hash}`, { method: "DELETE" }),
  lookup: (id: number, opts: { source?: LookupSource; q?: string } = {}) =>
    request<LookupResult>(`/api/lookup/${id}${qs({ source: opts.source, q: opts.q || undefined })}`),
  coverCandidates: (id: number, q?: string) => request<CoverSearchResult>(`/api/lookup/${id}/covers${qs({ q: q || undefined })}`),
  setCoverFromUrl: (id: number, url: string) =>
    request<BookDetailDto>(`/api/books/${id}/cover/from-url`, { method: "POST", body: JSON.stringify({ url }) }),
  applyMetadata: (id: number, req: ApplyMetadataRequest) =>
    request<BookActionResult>(`/api/books/${id}/apply-metadata`, { method: "POST", body: JSON.stringify(req) }),
  enqueueLookups: (ids: number[]) => request<LookupQueueStatus>("/api/lookup/bulk", { method: "POST", body: JSON.stringify({ ids }) }),
  lookupStatus: () => request<LookupQueueStatus>("/api/lookup/status"),
  lookupJobs: (ids: number[]) => request<Record<number, LookupJobDto | null>>(`/api/lookup/jobs${qs({ ids: ids.join(",") })}`),
  /** Metadata API usage; `since` (server epoch ms) bounds the session counts. Omit it to learn the server's time. */
  isbndbKey: () => request<IsbndbKeyDto | null>("/api/isbndb/key"),
  metadataUsage: (since?: number) => request<MetadataUsageDto>(`/api/metadata-usage${qs({ since })}`),
  cancelLookups: () => request<LookupQueueStatus>("/api/lookup/cancel", { method: "POST" }),
  retryFailedLookups: () => request<LookupQueueStatus>("/api/lookup/retry-failed", { method: "POST" }),
  reviewQueue: () => request<ReviewItemDto[]>("/api/review-queue"),
  skipReview: (id: number) => request<LookupQueueStatus>(`/api/review-queue/${id}`, { method: "DELETE" }),
  acceptFills: () =>
    request<{ applied: number; skipped: number; errors: string[] }>("/api/review-queue/accept-fills", { method: "POST" }),
  pageCount: (id: number, hash: string) => request<PagesDto>(`/api/books/${id}/files/${hash}/pages`),
  /** keepalive lets the last position survive closing the tab. */
  savePosition: (id: number, body: { hash: string; position: string; fraction: number | null }, keepalive = false) =>
    request<ReadingPosition>(`/api/books/${id}/position`, { method: "PUT", body: JSON.stringify(body), keepalive }),
  maintenanceStats: () => request<MaintenanceStats>("/api/maintenance/stats"),
  missingBooks: () => request<MissingBookDto[]>("/api/maintenance/missing"),
  forgetBooks: (ids: number[]) => request<CleanupResult>("/api/maintenance/missing", { method: "POST", body: JSON.stringify({ ids }) }),
  cleanup: () => request<CleanupResult>("/api/maintenance/cleanup", { method: "POST" }),
  applyMetadataRules: () => request<MetadataRulesResult>("/api/maintenance/rules", { method: "POST" }),
  /** shelf: undefined = whole library, "" = Unshelved. */
  normalizeAll: (shelf?: string) =>
    request<BulkRenameResult>("/api/maintenance/normalize", { method: "POST", body: JSON.stringify(shelf === undefined ? {} : { shelf }) }),
  clearHttpCache: () => request<{ removed: number }>("/api/maintenance/http-cache", { method: "DELETE" }),
  nameGroups: (field: CleanupField) => request<NameGroupsDto>(`/api/cleanup/groups${qs({ field })}`),
  mergeNames: (body: NameMergeRequest) => request<NameMergeResult>("/api/cleanup/merge", { method: "POST", body: JSON.stringify(body) }),
  searchAuthors: (q: string, source?: AuthorSource) => request<AuthorSearchDto>(`/api/cleanup/author-search${qs({ q, source })}`),
  booksWithName: (field: CleanupField, name: string) => request<BookRefDto[]>(`/api/cleanup/books${qs({ field, name })}`),
  swapSuspects: () => request<SwapSuspectDto[]>("/api/cleanup/swaps"),
  fixTitleAuthor: (body: TitleAuthorFixRequest) =>
    request<NameMergeResult>("/api/cleanup/swaps", { method: "POST", body: JSON.stringify(body) }),
  aliases: () => request<AliasDto[]>("/api/cleanup/aliases"),
  removeAlias: (field: CleanupField, variant: string) =>
    request<AliasDto[]>("/api/cleanup/aliases", { method: "DELETE", body: JSON.stringify({ field, variant }) }),
  removeCover: (id: number) => request<BookDetailDto>(`/api/books/${id}/cover`, { method: "DELETE" }),
  getStatus: () => request<LibraryStatus>("/api/library/status"),
  rescan: () => request<LibraryStatus>("/api/library/rescan", { method: "POST" }),
  getShelves: () => request<ShelfDto[]>("/api/shelves"),
  getBook: (id: number) => request<BookDetailDto>(`/api/books/${id}`),
  referenceSources: () => request<ReferenceSourceDto[]>("/api/reference"),
  importReferenceFromServer: (path: string) =>
    request<ReferenceSourceDto>("/api/reference/from-file", { method: "POST", body: JSON.stringify({ path }) }),
  removeReference: (source: string) => request<{ removed: string }>(`/api/reference/${encodeURIComponent(source)}`, { method: "DELETE" }),
};

/** Upload a reference file (raw body) with progress; resolves with the imported source. */
export function uploadReference(file: File, onProgress: (fraction: number) => void): Promise<ReferenceSourceDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/reference${qs({ name: file.name })}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as ReferenceSourceDto);
      else reject(new ApiRequestError(body?.error ?? (xhr.statusText || "Upload failed"), xhr.status));
    };
    xhr.onerror = () => reject(new ApiRequestError("Network error during upload", 0));
    xhr.send(file);
  });
}

/**
 * Upload one file (raw body) with progress. Resolves with the import result for
 * imported/attached/reconnected and duplicate (409) outcomes; rejects on errors.
 * `lookup` queues a metadata lookup when the upload creates a new book.
 */
export function uploadBook(
  file: File,
  target: { shelf: string | null; lookup?: boolean },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ImportResultDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/import${qs({ filename: file.name, shelf: target.shelf ?? undefined, lookup: target.lookup ? 1 : undefined })}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) resolve(body as ImportResultDto);
      else reject(new ApiRequestError(body?.error ?? (xhr.statusText || "Upload failed"), xhr.status));
    };
    xhr.onerror = () => reject(new ApiRequestError("Network error during upload", 0));
    xhr.onabort = () => reject(new ApiRequestError("Upload cancelled", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
