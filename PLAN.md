# Bookshelf — Implementation Plan

Self-hosted, single-user (LAN, no auth) book manager. Bun + TypeScript server, React frontend,
SQLite for **metadata only**. The filesystem is the single source of truth for *which* books exist.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Formats | EPUB, PDF, CBZ, CBR, DJVU, FB2 (`.fb2`, `.fb2.zip`/`.fbz`) |
| Library layout | `root/` = library; first-level dirs = bookshelves; files in `root/` = **Unshelved**; files in deeper subfolders belong to their top-level shelf |
| Book vs file | **One book can have several files** (e.g. EPUB + PDF of the same ISBN/DOI). One metadata row, N files on disk |
| File ↔ metadata link | SHA-256 content hash, with fallback to isbn13/doi parsed from filename/embedded metadata |
| Hash cache | Persistent `(path, size, mtime) → hash` table. Pure cache: never used to list books; pruned on every scan |
| Import | Browser upload (drag & drop) into a chosen shelf; original untouched (copy semantics) |
| Library filename | `{author} - {title} [{id}].{ext}`. All files of a book share the same stem |
| Multiple authors | Parse split on `, ` / ` & ` / ` and ` / `; `. Filename: `A`, `A & B`, `A et al.` |
| DOI in filenames | `/` ↔ `_` (only the first `_` after the `10.NNNN` prefix is converted back) |
| Metadata merge | Field-level: embedded wins per field, empty fields filled from filename, isbn13/doi from filename always stored; junk values treated as empty |
| Write-back on edit | **Rename files only**, never modify file contents (hash stays stable) |
| Hand-copied files | Auto-extract metadata into DB; **no** auto-rename (manual "Normalize filename", single + bulk) |
| Duplicates | Upload blocked if same hash, or same ID **and same format** as a file currently on disk. Same ID with a different format is attached to the existing book |
| External metadata | **Open Library** (ISBN / title+author) and **Crossref + doi.org** (DOI / bibliographic search). Diff review per book; bulk lookup feeds a review queue |
| Metadata retention | A row is **confirmed** if accepted from an external source (Open Library / DOI) **or edited manually**. When a book's last file disappears (in-app delete *or* external removal), confirmed rows are kept and unconfirmed rows are deleted |
| Shelf deletion | Never deletes books: book files are moved to the root (Unshelved), then the directory is removed |
| FS sync | Live recursive watcher + full scan at startup; UI updates over WebSocket |
| Root selection | First-run UI with server-side directory browser; stored in DB; `BOOKSHELF_LIBRARY_ROOT` env overrides |
| Stack | `Bun.serve` + HTML imports (HMR in dev), React, Mantine, raw `bun:sqlite` + numbered SQL migrations, `bun test` |
| External tools | Optional: `7z`/`unrar` (CBR), `djvused`/`ddjvu` (DJVU), `pdftoppm` (PDF cover). Detected at startup; absent → filename-only for that format. (None currently installed on this machine) |
| UI v1 | Shelf mgmt + moving books, search/sort/filter (FTS5), grid/list, download, in-browser reading, delete, tags/series/rating/notes, merge/detach files |

Bun 1.4.4 lives at `~/.bun/bin/bun`. See README.md for running and configuration.

---

## 2. Project layout

```
package.json  tsconfig.json  bunfig.toml
src/
  shared/
    types.ts              # DTOs shared by server and web
  server/
    index.ts              # Bun.serve: routes, HTML import, /ws
    config.ts             # data dir, env overrides, external tool detection
    db/
      index.ts            # open DB, pragmas (WAL, foreign_keys)
      migrate.ts
      migrations/001_init.sql
      repo/               # books.ts, authors.ts, tags.ts, settings.ts, hashCache.ts
    naming/
      parseFilename.ts    # import pattern + library pattern
      buildFilename.ts
      sanitize.ts  authors.ts  isbn.ts  doi.ts  formats.ts
    extract/
      index.ts            # dispatch by extension → RawMetadata
      epub.ts  pdf.ts  cbz.ts  cbr.ts  djvu.ts  fb2.ts
      merge.ts            # field-level merge with filename metadata
      junk.ts             # junk title/author detection
    library/
      index.ts            # in-memory LibraryIndex (the live view of disk)
      scanner.ts          # full walk + linking algorithm
      watcher.ts          # recursive fs.watch, debounce, stable-size wait
      retention.ts        # last-file-gone → keep/delete row (grace period)
      hasher.ts           # streaming SHA-256 (Bun.CryptoHasher)
      paths.ts            # shelf resolution, path-traversal guards
    covers/store.ts       # extract/download → data/covers/{id}.jpg + thumb .webp (sharp)
    sources/
      http.ts             # throttled fetch per host, response cache, backoff
      openlibrary.ts      # ISBN + search → Metadata candidates
      doi.ts              # Crossref REST, doi.org CSL-JSON fallback, Crossref bibliographic search
      diff.ts             # field-level diff current vs candidate
    services/
      importService.ts  bookService.ts  shelfService.ts
      renameService.ts    # normalize / rename-on-edit, collision handling
      jobs.ts             # background jobs (bulk lookup) with progress events
    api/
      router.ts  books.ts  shelves.ts  import.ts  lookup.ts
      settings.ts  fsBrowse.ts  maintenance.ts  events.ts
  web/
    index.html  main.tsx  App.tsx
    api/                  # typed fetch client + TanStack Query hooks + WS listener
    pages/  Setup.tsx  Library.tsx  BookDetail.tsx  Reader.tsx
            ReviewQueue.tsx  Settings.tsx
    components/  ShelfSidebar  BookGrid  BookList  UploadDropzone
                 MetadataDiff  BookEditForm  ConfirmDelete  MergeBooks ...
tests/
  fixtures/               # tiny generated epub/pdf/cbz/fb2 files, recorded API JSON
  *.test.ts
```

Data dir: `BOOKSHELF_DATA_DIR` (default `~/.local/share/bookshelf`) holds `bookshelf.db` and `covers/`.
It must not be inside the library root (validated when the root is set).

Libraries: `react`, `react-dom`, `@mantine/core|hooks|dropzone|notifications`, `@tanstack/react-query`,
`react-router`, `fast-xml-parser`, `fflate` (zip), `pdfjs-dist` (server metadata + web reader),
`react-reader`/`epubjs` (EPUB reader), `sharp` (thumbnails).

---

## 3. Database schema (`001_init.sql`)

```sql
settings(key TEXT PRIMARY KEY, value TEXT)

books(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, sort_title TEXT, subtitle TEXT,
  isbn13 TEXT, doi TEXT,
  publisher TEXT, published_date TEXT, year INTEGER, language TEXT, pages INTEGER,
  description TEXT,
  series TEXT, series_index REAL,
  rating INTEGER CHECK (rating BETWEEN 0 AND 5), notes TEXT,
  has_cover INTEGER NOT NULL DEFAULT 0, cover_source TEXT,   -- 'embedded' | 'openlibrary' | 'upload'
  ol_edition_key TEXT, ol_work_key TEXT,
  metadata_source TEXT,          -- 'embedded' | 'filename' | 'mixed'
  confirmed_source TEXT,         -- NULL | 'openlibrary' | 'doi' | 'manual'  (external never downgraded to manual)
  confirmed_at TEXT,
  reading_position TEXT,
  created_at TEXT, updated_at TEXT
)
CREATE INDEX books_isbn13 ON books(isbn13);  CREATE INDEX books_doi ON books(doi);

book_hashes(hash TEXT PRIMARY KEY, book_id INTEGER REFERENCES books ON DELETE CASCADE, format TEXT)
authors(id INTEGER PRIMARY KEY, name TEXT UNIQUE, sort_name TEXT)
book_authors(book_id, author_id, position, PRIMARY KEY(book_id, author_id))
tags(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE)
book_tags(book_id, tag_id, PRIMARY KEY(book_id, tag_id))

books_fts USING fts5(title, subtitle, authors, isbn13, doi, series, tags, description,
                     tokenize='unicode61 remove_diacritics 2')   -- rowid = books.id, maintained by repo code

file_hash_cache(path TEXT PRIMARY KEY, size INTEGER, mtime_ms INTEGER, hash TEXT)  -- cache only
http_cache(url TEXT PRIMARY KEY, status INTEGER, body TEXT, fetched_at TEXT)
```

No table records "this book is in the library". Presence = "at least one of its files exists on disk now".

---

## 4. Filenames

### 4.1 Import pattern (source files)

`{title} -- {author}[ -- …other segments…]` plus optional `isbn13 {13 digits}` / `doi {doi}` anywhere.
(Also handles Anna's Archive–style names: extra segments like publisher, year, md5 are ignored.)

1. Strip extension (`.fb2.zip` treated as one extension).
2. Extract IDs from the whole stem:
   - `isbn13[ :]?(97[89][\d-]{10,16})` → digits only; validate checksum (stored anyway, warning logged).
   - `doi[ :]?(10\.\d{4,9}[_/]…)` up to the next ` -- ` or end → first `_` after the prefix becomes `/`.
3. Remove ID tokens, split on ` -- `: segment 0 = title, segment 1 = authors.
4. No ` -- ` present → library pattern (4.2), else whole stem is the title.

### 4.2 Library pattern (files the app renamed)

`{author} - {title} [{id}].{ext}`, `id` = bare ISBN-13 (`9780131103627`) else DOI (`10.1000_xyz`), else no bracket.
Parse: `^(.+?) - (.+?)(?: \[([^\]]+)\])?$`; bracket = ISBN if 13 digits starting 978/979, DOI if it starts with `10.`.
Known limitation: a plain hand-copied name like `Some Book - Part 2` (no DB row, no embedded metadata) parses as
author `Some Book`, title `Part 2`; it is fixable by editing and only affects the fallback path.

DOI reversal is ambiguous when the suffix had several `/`; DOI lookups retry the candidates from
`doiCandidatesFromFilename` (`10.1093_ajae_aaq063` → `10.1093/ajae_aaq063`, then `10.1093/ajae/aaq063`).

### 4.3 Building names

- Author part: first author; `A & B` for two; `A et al.` for 3+; `Unknown` if none. Names in display form.
- Sanitize: `:` → ` -`, `/ \ * ? " < > |` and control chars → `_`, collapse whitespace, trim dots/spaces.
- Max 255 bytes UTF-8: truncate title first, then author part.
- Collision in the target dir → ` (2)`, ` (3)` … (a book's own files of other formats don't count as collisions).
- Author splitting heuristic: `"Tolkien, J. R. R."` (two comma parts, second is initials/first-name only) → one author, `J. R. R. Tolkien`.

---

## 5. Library index, scanning, linking, retention

`LibraryIndex` (in memory): `Map<relPath, {size, mtimeMs, hash, bookId, shelf, format}>`, plus `bookId → paths[]`.
Built by a full scan at startup / root change; kept current by the watcher. Ignores hidden files/dirs
(including the app's `.bookshelf-incoming/`), partial downloads (`.part`, `.crdownload`), unsupported extensions.

**Linking algorithm** for a file F (format X):
1. `hash` ← `file_hash_cache` if `(path,size,mtime)` match, else stream-hash and update cache.
2. `book_hashes[hash]` exists → link.
3. Else IDs from filename (and, if none, embedded metadata). If a row with that isbn13/doi exists:
   - it has no file of format X currently on disk → link (attach F as a file of that book), add the hash;
   - it already has an on-disk file of format X → F becomes its own book row (hand-copied duplicate; flagged in UI).
4. Else extract metadata (§6), create row + hash + cover. (Hand-copied file: no rename.)

Books without IDs are never auto-grouped; the UI offers **Merge books** (move the source's hashes to the target, drop the
source row) and **Detach file** (split one file into a new row with freshly extracted metadata).

**Watcher**: `fs.watch(root, { recursive: true })` (verified working on Bun 1.4 / Linux, including newly created and
renamed subdirectories), per-path debounce (~500 ms); new/changed files must keep the same size+mtime for 2 s before processing.
Event for a missing path → drop that file or everything under that directory; event for a directory → walk it.
- No suppression set is needed: app-initiated operations (import, rename, move) update the index and hash cache *first*,
  so the watcher sees a matching size+mtime and does nothing.
- Moves are recognised by inode+size+mtime (either event order), so moved files and renamed shelves are never re-hashed.
- If the root is inaccessible (e.g. unmounted drive) the library is `unavailable`, polls every 60 s and re-attaches the
  watcher when it returns. If recursive watching fails, it falls back to periodic rescans.

**Retention** (`retention.ts`): when a book's last on-disk file disappears, start a 10 s grace timer (a move appears as remove +
add; the add re-links by hash and cancels the timer). On expiry: `confirmed_source` set → keep row (and hashes, so the file
reconnects if it returns); otherwise delete row + hashes + cover. In-app deletes apply the rule immediately.
Every full scan (startup, root change, manual rescan) ends with the same rule for rows that have no files, **guarded**:
skipped if the root is inaccessible or the scan found 0 files while rows exist. Settings lists kept (confirmed) rows without files.

---

## 6. Metadata extraction

| Format | Source | Fields | Cover |
|---|---|---|---|
| EPUB | `META-INF/container.xml` → OPF | dc:title, dc:creator (+`file-as`), dc:identifier (ISBN/urn:isbn/doi), publisher, date, language, description, subject→tags, calibre:series/series_index, EPUB3 `belongs-to-collection` | `meta name=cover` / `properties=cover-image` |
| PDF | pdfjs-dist `getMetadata()` | Info dict Title/Author/Subject/Keywords + XMP dc:*, prism:doi | `pdftoppm -f 1 -l 1` if available |
| CBZ | `ComicInfo.xml` | Title, Series, Number, Writer, Year, Summary, Publisher, GTIN(ISBN), Tags | first image (natural sort) |
| CBR | `7z`/`unrar` → ComicInfo.xml | same as CBZ | first image |
| DJVU | `djvused -e print-meta` | title, author, year, … | `ddjvu -page=1` → sharp |
| FB2 | `<title-info>`, `<publish-info>` | book-title, authors, genres→tags, annotation, sequence, isbn, lang | `<coverpage>` binary |

**Junk filter** (value treated as empty): titles like `untitled`, `Microsoft Word - …`, `*.doc(x)`, `*.tex`,
`document1`, pure numbers/hashes, equal to the filename stem; authors like `Administrator`, `user`, `owner`, `Unknown`.

**Merge**: per field, embedded value if non-junk, else filename value. isbn13/doi from the filename always stored
(filename wins if both differ). `metadata_source` = `embedded` / `filename` / `mixed`.

**Multi-format books**: metadata quality rank EPUB > FB2 > CBZ/CBR > DjVu > PDF. Full scans process files in that order.
When a file is attached by identifier to an **unconfirmed** book, its metadata is recomputed: the better-ranked file wins
per field, the other fills gaps, and the better file's cover replaces an embedded one. Confirmed books are never rewritten.

**Implementation notes**: EPUB/CBZ/FB2-zip use a small random-access ZIP reader (central directory + per-entry inflate,
ZIP64 aware), so large archives are never loaded whole. PDFs are read by pdf.js through a range transport (only needed
byte ranges). CBR is read natively when it is really a ZIP, otherwise through `7z` (`-spd`, literal names) or `unrar`.
Covers are extracted lazily (only when needed) and stored as `{id}.jpg` (≤1200×1800) + `{id}.thumb.webp` (≤320×480),
served with ETags. Extraction never throws (60 s timeout per file); failures fall back to the filename.

---

## 7. Import flow (browser upload)

`POST /api/import?filename=<original name>&shelf=<name>` with the raw file as the body (one request per file;
the UI uploads 2 at a time with per-file progress). 201 imported/reconnected, 200 attached, 409 duplicate, 400 invalid.

1. Validate extension and shelf (must be an existing first-level directory; omitted = Unshelved); wait for any running scan.
2. Stream to `{root}/.bookshelf-incoming/{uuid}.{ext}` (same filesystem → atomic rename), hashing while writing;
   limit `BOOKSHELF_MAX_UPLOAD_MB` (default 16 GiB). The staging dir is removed when no upload is in flight.
3. Same content already on disk → `duplicate` (before any extraction).
4. Extract + merge metadata (§6) using the *original* filename.
5. Under the linker lock: same ID with an on-disk file of the same format → `duplicate`. Content hash or ID of a kept
   (confirmed) row without files → `reconnected` (into the chosen shelf). Same ID, other format → `attached`, placed next
   to the book's existing file(s). Otherwise `imported` (new row).
6. Build `{author} - {title} [{id}].{ext}` from the (possibly re-merged) book record, ` (n)` on collision, rename into place,
   update hash cache and index synchronously so the watcher sees nothing new. Cover is read from the final file.

UI: "Add books" button and a full-window drop target open the queue dialog (shelf selector defaults to the shelf being
viewed; unsupported files are rejected client-side).

---

## 8. External metadata sources (implemented)

**Open Library** — by ISBN: `api/books?jscmd=data` (title, authors, publisher, date, pages, subjects, cover), then that
same edition's `/books/{OLID}.json` (language, series, work key — *not* `/isbn/`, which may resolve to another edition of
the same ISBN), then `/works/{key}.json` for description/subjects if still missing. Search: `/search.json` gives
work-level candidates (no ISBN: a work spans many editions). Covers from `covers.openlibrary.org` (`?default=false`).

**DOI** — `api.crossref.org/works/{doi}`; on 404 `doi.org/{doi}` with CSL-JSON content negotiation (DataCite etc. — arXiv
DOIs are only found this way); for filename DOIs with `_`, the all-slashes spelling is retried. Search:
`works?query.bibliographic=` (note: `isbn-type`/`language` are not valid `select` fields there).

**Strategy**: ISBN → OL; DOI → DOI registries; nothing found (or no identifier) → title/author search in both. A typed
ISBN/DOI is exact (no fallback search); free text searches. Source can be forced.

**HTTP**: UA `Bookshelf/0.1 (self-hosted book manager; mailto:…)` (+ Crossref `mailto=` param when a contact email is set),
1 request/s per host, retries 429/5xx honouring `Retry-After`, `http_cache` (200: 7 days, 404: 1 day).

**Review**: candidates are compared field by field (`same` / `fill` / `conflict` / `missing`; case/punctuation-insensitive,
tags order-insensitive, a more precise date counts as `fill`). Missing fields are pre-selected, differences need an explicit
tick; the cover is pre-selected only when the book has none. Applying never clears a field, goes through the normal edit
validation (ISBN/DOI conflicts → 409, renames on title/author/ID change), stores OL keys and sets
`confirmed_source = openlibrary | doi`. Applying with nothing selected = "confirm as correct". Cover downloads are only
allowed from `covers.openlibrary.org`.

**Bulk**: a single background worker processes queued book ids (deduplicated); results are stored in `review_queue`
(migration 002, survives restarts; diffs recomputed when read); progress via `lookup.status` WebSocket events. "Fill missing
fields" accepts only `fill` fields (and a cover for cover-less books) of ISBN/DOI matches; title-search matches always need
manual review.

---

## 9. HTTP API

```
GET    /api/library?shelf=&q=&sort=title|author|added|year&order=&tags=&format=&series=&page=&size=
GET    /api/books/:id                 PATCH /api/books/:id
DELETE /api/books/:id                 (all files; retention rule)
DELETE /api/books/:id/files/:hash     (one file; retention rule if it was the last)
POST   /api/books/:id/move {shelf}    POST /api/books/move {ids, shelf}
POST   /api/books/:id/normalize-filename           POST /api/books/normalize-filenames {ids}
POST   /api/books/:id/merge {intoId}  POST /api/books/:id/files/:hash/detach
GET    /api/books/:id/files/:hash?download=1 (Range)   GET /api/books/:id/cover?size=thumb|full
PUT    /api/books/:id/cover (upload)  GET /api/books/:id/files/:hash/pages[/:n]   (CBZ/CBR reader)
GET    /api/shelves                   POST /api/shelves {name}      PATCH /api/shelves/:name {name}
DELETE /api/shelves/:name             (books → root, then dir removed; see below)
POST   /api/import (multipart)
GET    /api/lookup/:bookId?source=openlibrary|doi&q=   → candidates + diff
POST   /api/books/:id/apply-metadata {source, fields, coverUrl?}
POST   /api/lookup/bulk {ids} → {jobId}   GET /api/jobs/:id   GET /api/review-queue
GET    /api/settings  PUT /api/settings   GET /api/fs/browse?path=   (directories only)
GET    /api/maintenance/missing           DELETE /api/maintenance/unconfirmed
GET    /api/tags  /api/series  /api/authors
WS     /ws   events: library.changed, scan.progress, job.progress, import.progress
```

**Shelf delete**: every book file anywhere in the shelf (including subfolders) is moved to the root, with ` (2)` collision
suffixes. Junk files (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are discarded. If other non-book files remain, the request is
refused **before anything moves** (409 with the file list), so nothing is ever deleted silently.

All shelf names and paths are validated (no `..`, no separators, no hidden names) and resolved under the root.

---

### Editing rules (implemented)

- `PATCH /api/books/:id` (any field, incl. rating/tags/notes) is a manual edit → `confirmed_source = 'manual'`
  (an external confirmation is never downgraded). Title/author/ISBN/DOI changes rename all of the book's files in place.
- Setting an ISBN/DOI that another book already has → 409 with a hint to merge instead.
- Normalize filenames (single + bulk) renames without touching or confirming metadata.
- Merge: the target keeps its metadata (empty fields filled from the source, tags united), takes the source's hashes,
  files and (if it has none) cover; the source row is deleted; files are renamed; refused when both have the same format.
- Detach: the file gets a new unconfirmed row created directly from its own metadata (never re-attached by ID).
- Cover upload/removal is a manual edit too. `GET /api/facets` lists tags/series/authors/formats/languages/publishers
  of books on disk (filters + autocomplete).

### Shelves, moving, deleting (implemented)

- Create = `mkdir`; rename = directory rename with index/hash-cache paths rewritten (no re-hashing, metadata untouched).
- Delete shelf: everything inside is classified first. Book files (also in subfolders) move to the root with ` (n)` on
  collision; OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is removed; anything else (incl. hidden files, partial
  downloads) → 409 with the list and **nothing is changed**. Folders are removed with `rmdir` only, never recursively.
- Move books: all on-disk files of each book go to the top level of the target shelf (null = Unshelved); files already
  on that shelf stay put. Cross-filesystem moves (a shelf can be a mount point) fall back to copy + unlink.
- Delete books / single files: permanent `unlink` after an explicit confirmation that states the metadata outcome;
  the retention rule runs immediately (confirmed rows kept, others removed with their cover).
- UI: drag books (or the whole selection) onto a sidebar shelf, "Move to" submenus, shelf ⋯ menu (rename/delete), "+"
  for new shelves.

### Reading and downloads (implemented)

- `GET|HEAD /api/books/:id/files/:hash` serves the file (only files of that book, looked up in the index) with
  `ETag` = content hash, single byte ranges (206/416, suffix and open-ended ranges, `If-Range`) and an RFC 6266
  `Content-Disposition` (`?download=1` → attachment) carrying the exact UTF-8 filename.
- Page images: `/pages` (count) and `/pages/:n` for CBZ (native ZIP), CBR (7z/unrar; ZIP-in-disguise natively) and
  DJVU (`ddjvu` → JPEG). Archive listings are kept in a small LRU; page URLs contain the content hash → `immutable`.
- `PUT /api/books/:id/position` `{hash, position, fraction}` stores reader state (EPUB CFI or page number); it does not
  confirm the book or change `updated_at`. Summaries expose `progress` (grid shows a bar; book page "Continue · 42%").
- Readers (route `/read/:id/:hash`, outside the app shell): EPUB via epub.js (paginated, TOC drawer, font size,
  auto/light/sepia/dark, no scripted content); PDF via pdf.js (worker/CMaps/fonts served from `/vendor/pdfjs/…`,
  range loading, continuous scroll, lazy page rendering and release, fit-width/zoom, jump to page, link to the
  browser's own viewer); CBZ/CBR/DJVU page reader (fit screen/width, click halves or arrow keys, L→R/R→L per book,
  slider, preloading). FB2: download only. Positions are saved debounced and flushed with `keepalive` on hide/unload.
- Known limitation: Bun's HTML import does not code-split, so the readers are in the main bundle (~1.7 MB minified in
  production). A separate `bun build --splitting` step could be added later if that matters.

## 10. Frontend (React + Mantine)

- **Setup**: first run → directory browser → set root → initial scan progress.
- **Library**: AppShell with a shelf sidebar (All, Unshelved, shelves with counts, create/rename/delete), search bar,
  sort/filter (format, tags, series, rating, has-ID, confirmed/unconfirmed, missing metadata), grid/list toggle,
  format badges per book (EPUB · PDF), multi-select toolbar (move, delete, bulk lookup, normalize filenames),
  drag books onto sidebar shelves to move.
- **Book detail**: cover, metadata, confirmed badge (source), edit form, file list (format, path, size, read/download/delete/detach
  per file), actions: Lookup, Normalize filename, Merge with…, Delete book. Delete dialog states whether metadata will be kept.
- **Reader**: EPUB → `react-reader`; PDF → pdfjs-dist; CBZ/CBR → image pager. DJVU/FB2 → download only in v1.
- **Review Queue**, **Settings** (root, contact email, external tool status, missing/unconfirmed cleanup, rescan).
- WS hook invalidates TanStack Query caches.

---

## 11. Milestones (all implemented)

1. ✅ **Scaffold**: Bun project, tsconfig, Bun.serve with HTML import + Mantine shell, DB + migrations, settings, root picker.
2. ✅ **Naming module** + exhaustive unit tests (parse/build/sanitize/authors/ISBN/DOI).
3. ✅ **Library core**: hasher, hash cache, scanner + linking (multi-file), LibraryIndex, retention, listing API, watcher, WS.
4. ✅ **Extractors**: EPUB, FB2, CBZ, PDF → merge/junk → covers; then CBR/DJVU/pdftoppm via optional tools.
5. ✅ **Import**: upload endpoint, duplicate/attach logic, rename into shelf, dropzone UI.
6. ✅ **Library UI**: sidebar, grid/list, FTS search, sort/filter, detail + edit, rename-on-edit, merge/detach.
7. ✅ **Shelf management**: create/rename/delete (books → root), move books, delete books/files.
8. ✅ **External sources**: Open Library + DOI clients, single lookup + diff, covers, bulk job + review queue.
9. ✅ **Readers + download** (Range requests).
10. ✅ **Maintenance**: missing/unconfirmed cleanup, bulk normalize, rescan, tool status. README.

Tests: `bun test` — naming/merge/junk units; extractor tests on tiny fixtures; scanner/linking/retention/import integration
tests on temp dirs (rename, move, multi-format attach, external delete with/without confirmation, unmounted-root guard,
shelf delete); source clients on recorded JSON (no network).
