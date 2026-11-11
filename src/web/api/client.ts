import type {
  CleanupResult,
  MaintenanceStats,
  MissingBookDto,
  PagesDto,
  ReadingPosition,
  ApplyMetadataRequest,
  LookupQueueStatus,
  LookupResult,
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
  applyMetadata: (id: number, req: ApplyMetadataRequest) =>
    request<BookActionResult>(`/api/books/${id}/apply-metadata`, { method: "POST", body: JSON.stringify(req) }),
  enqueueLookups: (ids: number[]) => request<LookupQueueStatus>("/api/lookup/bulk", { method: "POST", body: JSON.stringify({ ids }) }),
  lookupStatus: () => request<LookupQueueStatus>("/api/lookup/status"),
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
  /** shelf: undefined = whole library, "" = Unshelved. */
  normalizeAll: (shelf?: string) =>
    request<BulkRenameResult>("/api/maintenance/normalize", { method: "POST", body: JSON.stringify(shelf === undefined ? {} : { shelf }) }),
  clearHttpCache: () => request<{ removed: number }>("/api/maintenance/http-cache", { method: "DELETE" }),
  removeCover: (id: number) => request<BookDetailDto>(`/api/books/${id}/cover`, { method: "DELETE" }),
  getStatus: () => request<LibraryStatus>("/api/library/status"),
  rescan: () => request<LibraryStatus>("/api/library/rescan", { method: "POST" }),
  getShelves: () => request<ShelfDto[]>("/api/shelves"),
  getBook: (id: number) => request<BookDetailDto>(`/api/books/${id}`),
};

/**
 * Upload one file (raw body) with progress. Resolves with the import result for
 * imported/attached/reconnected and duplicate (409) outcomes; rejects on errors.
 */
export function uploadBook(file: File, shelf: string | null, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<ImportResultDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/import${qs({ filename: file.name, shelf: shelf ?? undefined })}`);
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
