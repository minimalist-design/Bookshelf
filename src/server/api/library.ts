import type { AppContext } from "../app.ts";
import { libraryFacets, listLibrary, listShelves, toDetail } from "../library/queries.ts";
import type { BookFormat, LibraryQuery, LibrarySort, MissingFilter } from "../../shared/types.ts";
import { NotFoundError } from "./http.ts";

const SORTS: readonly LibrarySort[] = ["title", "author", "added", "year", "series", "rating"];
const FORMATS: readonly BookFormat[] = ["epub", "pdf", "cbz", "cbr", "djvu", "fb2"];
const MISSING: readonly MissingFilter[] = ["id", "author", "cover", "description"];

export function parseLibraryQuery(url: URL): LibraryQuery {
  const p = url.searchParams;
  const sort = p.get("sort") as LibrarySort | null;
  const format = p.get("format") as BookFormat | null;
  const missing = p.get("missing") as MissingFilter | null;
  const confirmed = p.get("confirmed");
  const minRating = Number(p.get("minRating"));
  return {
    shelf: p.has("shelf") ? p.get("shelf")! : undefined,
    q: p.get("q") ?? undefined,
    format: format && FORMATS.includes(format) ? format : undefined,
    tag: p.get("tag") || undefined,
    series: p.get("series") || undefined,
    author: p.get("author") || undefined,
    confirmed: confirmed === "true" ? true : confirmed === "false" ? false : undefined,
    missing: missing && MISSING.includes(missing) ? missing : undefined,
    minRating: minRating > 0 ? minRating : undefined,
    sort: sort && SORTS.includes(sort) ? sort : undefined,
    order: p.get("order") === "desc" ? "desc" : "asc",
    page: Number(p.get("page")) || undefined,
    size: Number(p.get("size")) || undefined,
  };
}

export function libraryPage(app: AppContext, url: URL) {
  return listLibrary(app.library.index, app.books, parseLibraryQuery(url));
}

export function shelves(app: AppContext) {
  const root = app.library.rootPath;
  return root ? listShelves(root, app.library.index) : [];
}

/** A book is visible only while at least one of its files is on disk. */
export function bookDetail(app: AppContext, id: number) {
  const files = app.library.index.filesOfBook(id);
  const book = files.length ? app.books.get(id) : null;
  if (!book) throw new NotFoundError(`Book ${id} not found`);
  return toDetail(book, files);
}

/** Serve a stored cover (thumb or full) with ETag revalidation. */
export function coverResponse(app: AppContext, id: number, sizeParam: string | null, req: Request): Response {
  const size = sizeParam === "full" ? "full" : "thumb";
  const etag = app.covers.etag(id, size);
  if (!etag || !app.books.get(id)?.hasCover) throw new NotFoundError("No cover");
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(app.covers.path(id, size)), {
    headers: { ...headers, "Content-Type": size === "full" ? "image/jpeg" : "image/webp" },
  });
}

export function facets(app: AppContext) {
  return libraryFacets(app.library.index, app.books);
}
