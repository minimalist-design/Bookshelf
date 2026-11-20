# HTTP API

Bookshelf's only interface. All paths are under `/api`, except the `/ws` event socket. Bodies are JSON unless
noted, and response shapes are the types in [`src/shared/types.ts`](../src/shared/types.ts) (named in *italics*
below). There is no authentication (see the README).

**Errors** are `{ "error": "<message>" }` with status `400` (invalid input), `404` (unknown book, file, shelf or
path), `409` (conflict; `details` may carry more) or `503` (a library or tool that isn't available). Any path
outside the API answers `404` with `{ "error": "Not found" }`.

**Ids.** Books are addressed by numeric id and exist only while one of their files is on disk. A file is
addressed by its content hash (`files[].hash` in a book). Endpoints taking `ids` expect a non-empty list of
positive integers.

## Health and settings

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET, HEAD | `/api/health` | | `200 {ok: true}` while the server and database work, else `503` |
| GET | `/api/settings` | | *SettingsDto* (library root, data dir, detected tools, ISBNdb limits) |
| PUT | `/api/settings` | *SettingsUpdate*: `libraryRoot` (path, or `null` to unlink; no files touched), `createLibraryRoot` (create a missing directory), `contactEmail` (sent to metadata services as identification) | *SettingsDto*; re-indexing runs in the background |
| GET | `/api/isbndb/key` | | *IsbndbKeyDto*: the key's plan and today's quota (one ISBNdb call) |
| GET | `/api/metadata-usage` | `since` (epoch ms) | *MetadataUsageDto*: calls per metadata service |

A library root set in the config file (`library_root`) can't be changed through the API
(`libraryRootFromConfig: true`).

## Library and shelves

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/library` | `q` (full text), `shelf` (name; empty = Unshelved; omitted = all), `format`, `tag`, `series`, `author`, `confirmed` (`true`/`false`), `missing` (`id`, `author`, `cover`, `description`), `minRating`, `sort` (`title`, `author`, `added`, `year`, `series`, `rating`), `order` (`asc`/`desc`), `page`, `size` | *LibraryPage* of *BookSummaryDto* |
| GET | `/api/library/status` | | *LibraryStatus* |
| POST | `/api/library/rescan` | | `202` *LibraryStatus* |
| GET | `/api/facets` | | *LibraryFacets*: authors, tags, series, publishers, languages and formats with counts |
| GET | `/api/shelves` | | *ShelfDto*[] (folders directly in the library root) |
| POST | `/api/shelves` | `{name}` | `201` *ShelfDto*; creates the folder |
| PATCH | `/api/shelves/:name` | `{name}` | *ShelfDto*; renames the folder |
| DELETE | `/api/shelves/:name` | | *ShelfDeleteResult*: book files move to the root (Unshelved); never deletes books |

## Books

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/books/:id` | | *BookDetailDto* |
| PATCH | `/api/books/:id` | *BookUpdate* (any subset of fields) | *BookActionResult*; confirms the metadata as `manual` |
| DELETE | `/api/books/:id` | | *DeleteResult*; deletes the book's files |
| POST | `/api/books/delete` | `{ids}` | *DeleteResult* |
| POST | `/api/books/move` | `{ids, shelf}` (`shelf: null` = Unshelved) | *MoveResult* |
| POST | `/api/books/normalize-filenames` | `{ids}` | *BulkRenameResult*: files renamed `Author - Title [ID].ext` |
| POST | `/api/books/:id/normalize-filename` | | *BulkRenameResult* |
| POST | `/api/books/:id/merge` | `{intoId}` | *BookActionResult*: `:id`'s files join `intoId` |
| GET, HEAD | `/api/books/:id/files/:hash` | `download` (any value: attachment instead of inline) | the file, with byte ranges and ETag |
| DELETE | `/api/books/:id/files/:hash` | | *DeleteResult*; deletes that file |
| POST | `/api/books/:id/files/:hash/detach` | | *BookActionResult*: the file becomes a book of its own |

## Covers

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/books/:id/cover` | `size` (`thumb`, default: WebP ≤320×480; `full`: JPEG ≤1200×1800) | the image, with ETag; `404` without a cover |
| PUT | `/api/books/:id/cover` | raw image bytes (max 50 MB) | *BookDetailDto* |
| DELETE | `/api/books/:id/cover` | | *BookDetailDto* |
| POST | `/api/books/:id/cover/from-url` | `{url}` | *BookDetailDto* |
| GET | `/api/lookup/:id/covers` | `q` (optional search text) | *CoverSearchResult*: covers offered by the metadata services |

## Import

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/api/import` | raw file body; `filename` (original name, required), `shelf` (omitted/empty = Unshelved), `lookup=1` (queue a metadata lookup for a new book) | *ImportResultDto*: `201` imported, `200` attached to an existing book, `409` duplicate |

Accepted extensions: `SUPPORTED_EXTENSIONS` in `src/shared/types.ts`.

## Metadata lookups and the review queue

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/lookup/:id` | `source` (`isbndb`, `openlibrary`, `doi`; default: all that apply), `q` (search text instead of the book's IDs) | *LookupResult*: candidates with a field-by-field diff |
| POST | `/api/books/:id/apply-metadata` | *ApplyMetadataRequest*: `candidate`, `fields` to take, `cover`, optional `edits` | *BookActionResult*; confirms the book with the candidate's source |
| POST | `/api/lookup/bulk` | `{ids}` | `202` *LookupQueueStatus*; runs in the background |
| GET | `/api/lookup/status` | | *LookupQueueStatus* |
| GET | `/api/lookup/jobs` | `ids` (comma-separated book ids) | *LookupJobDto*[] |
| POST | `/api/lookup/cancel` | | *LookupQueueStatus* |
| POST | `/api/lookup/retry-failed` | | `202` *LookupQueueStatus* |
| GET | `/api/review-queue` | | *ReviewItemDto*[]: bulk results waiting for review |
| POST | `/api/review-queue/accept-fills` | | `{applied, skipped, errors}`: applies every result that only fills empty fields |
| DELETE | `/api/review-queue/:id` | | *LookupQueueStatus* |

## Name cleanup

`field` is one of `authors`, `tags`, `series`, `publishers`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/cleanup/groups` | `field` | *NameGroupsDto*: spelling variants that look like one name |
| GET | `/api/cleanup/books` | `field`, `name` | *BookRefDto*[] |
| POST | `/api/cleanup/merge` | *NameMergeRequest*: `{field, from, to}` | *NameMergeResult*; remembers the alias |
| GET | `/api/cleanup/aliases` | | *AliasDto*[] |
| DELETE | `/api/cleanup/aliases` | `{field, variant}` | *AliasDto*[] |
| GET | `/api/cleanup/author-search` | `q`, `source` (`wikidata`, `openlibrary`) | *AuthorSearchDto* |
| GET | `/api/cleanup/swaps` | | *SwapSuspectDto*[]: books whose title and author look swapped |
| POST | `/api/cleanup/swaps` | *TitleAuthorFixRequest*: `{items}` | *NameMergeResult* |

## Maintenance

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/maintenance/stats` | | *MaintenanceStats* |
| GET | `/api/maintenance/missing` | | *MissingBookDto*[]: metadata kept for books whose files are gone |
| POST | `/api/maintenance/missing` | `{ids}` | *CleanupResult*; forgets (deletes) that metadata |
| POST | `/api/maintenance/cleanup` | | *CleanupResult*: orphaned covers and temp files removed |
| POST | `/api/maintenance/rules` | | *MetadataRulesResult*: built-in metadata rules applied to every book |
| POST | `/api/maintenance/normalize` | `{shelf?}` (name, `""` = Unshelved, omitted/`null` = all) | *BulkRenameResult* |
| DELETE | `/api/maintenance/http-cache` | | `{removed}`: cached metadata responses dropped |

## Reference data

See [reference-data-format.md](reference-data-format.md).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/reference` | | *ReferenceSourceDto*[] |
| POST | `/api/reference` | raw file body; `name` (file name) | `201` *ReferenceSourceDto* |
| POST | `/api/reference/from-file` | `{path}` (a file on the server) | `201` *ReferenceSourceDto* |
| DELETE | `/api/reference/:source` | | `{removed}` |

## Events: `/ws`

A WebSocket that only sends: each message is one JSON *ServerEvent*.

| `type` | Payload | When |
|---|---|---|
| `library.status` | `status`: *LibraryStatus* | on connect, and when scanning starts, progresses or ends |
| `library.changed` | `bookIds` | books were added, changed or removed (on disk or through the API) |
| `lookup.status` | `status`: *LookupQueueStatus* | bulk lookup progress |
