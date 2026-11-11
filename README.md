# Bookshelf

A self-hosted book manager for a directory of e-books. Bun + TypeScript server, React (Mantine) web UI, SQLite.

**The filesystem is the library.** The chosen root directory is the library, each folder directly inside it is a
bookshelf, and files directly in the root are *Unshelved*. The database stores metadata only — never *which* books
exist. Delete a file in your file manager and it disappears from the library; copy one in and it appears.

## Features

- EPUB, PDF, CBZ, CBR, DJVU and FB2 (`.fb2`, `.fb2.zip`, `.fbz`).
- Metadata from the file (EPUB OPF, PDF Info/XMP, ComicInfo.xml, DJVU, FB2), else from the filename
  (`Title -- Author -- isbn13 … -- doi …`), merged per field.
- One book can have several files (EPUB + PDF of the same ISBN/DOI are one book).
- Live updates: a recursive watcher picks up files added, moved, renamed or removed outside the app.
- Browser upload with duplicate detection; imported files are renamed `Author - Title [ISBN or DOI].ext`.
- Grid/list views, full-text search, filters (format, tag, series, author, rating, missing data…), sorting.
- Editing (tags, series, rating, notes, cover…), merge/split, move between shelves (drag & drop), delete.
- Metadata lookups in Open Library and the DOI registries (Crossref, doi.org/DataCite) with a field-by-field review,
  bulk lookups and a review queue.
- In-browser readers: EPUB, PDF, comics (CBZ/CBR) and DJVU, with reading position saved.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer.
- Optional tools (detected at startup, listed in *Settings*):
  - `7z` (7-Zip) or `unrar` — CBR metadata, covers and reading.
  - `djvused`, `ddjvu` (djvulibre) — DJVU metadata, covers and reading.
  - `pdftoppm` (poppler) — PDF cover images.

  Without them those files are still listed, using their filename.

## Running

```sh
bun install
bun run dev        # development: hot reload, http://localhost:3000
bun run start      # production
```

On first start the web UI asks for the library directory (a server-side folder browser). It can be changed later in
*Settings*, or fixed with `BOOKSHELF_LIBRARY_ROOT`.

| Variable | Default | Meaning |
|---|---|---|
| `BOOKSHELF_LIBRARY_ROOT` | — | Library directory; overrides (and locks) the UI setting |
| `BOOKSHELF_DATA_DIR` | `$XDG_DATA_HOME/bookshelf` or `~/.local/share/bookshelf` | Database and cover images (must not be inside the library) |
| `BOOKSHELF_PORT` / `PORT` | `3000` | HTTP port |
| `BOOKSHELF_HOST` | `0.0.0.0` | Bind address |
| `BOOKSHELF_MAX_UPLOAD_MB` | `16384` | Largest accepted upload |

> **There is no authentication.** Bookshelf is meant for a single user on a trusted network. Do not expose it to
> the internet without putting it behind an authenticating reverse proxy (which must also forward the `/ws`
> WebSocket).

## How it behaves

### Filenames

- **Import pattern** (files you add): `Title -- Author[, Author…][ -- anything]` plus optional `isbn13 9780…` and/or
  `doi 10.xxxx_yyy` anywhere. DOIs use `_` instead of `/` (filenames cannot contain `/`). Extra ` -- ` segments, as in
  Anna's Archive names, are ignored. Authors may be separated by `,`, `;`, `&` or `and`; `Last, First` is understood.
- **Library pattern** (files the app names): `Author - Title [9780131103627].epub`, `A & B - Title …`,
  `A et al. - Title [10.1145_3290605.3300857].pdf`. ` (2)` is added on collisions.
- Hand-copied files keep their names until you choose *Normalize filenames* (book page, selection, or Settings).

### Metadata, confirmation and retention

- Each file is linked to its metadata by SHA-256 content hash (with a hash cache keyed by path/size/mtime), falling
  back to the ISBN/DOI. Renaming or moving files therefore never loses metadata.
- Metadata is **confirmed** when accepted from Open Library / a DOI registry, or when you edit anything manually.
- When a book's last file disappears (deleted in the app *or* outside it): confirmed metadata is **kept** (and
  reconnected if the file returns); unconfirmed metadata is removed — it can always be re-read from the file.
  Removals outside the app wait 10 s so that moves are not mistaken for deletions, and a scan that finds an empty
  library (e.g. an unmounted drive) never removes anything.
- Editing title, authors or ISBN/DOI renames the book's files. File contents are never modified.

### Importing

Use *Add books* or drop files anywhere on the page. Files are copied into the chosen shelf. An identical file, or the
same ISBN/DOI in the same format, is rejected as a duplicate; a new format of an existing book is placed next to its
other files.

### Shelves

Create, rename and delete shelves from the sidebar. Deleting a shelf never deletes books: they move to Unshelved. If
the folder holds other (non-book) files, nothing is changed and you get the list.

### Lookups

*Look up* on a book searches by ISBN (Open Library) or DOI (Crossref, then doi.org), else by title/author. Missing
fields are pre-selected, differing ones need a tick. Bulk lookups (select books → *Actions*) fill the *Review queue*.
Requests are limited to one per second per service and cached for a week; set a contact email in *Settings* to be
identified to the services (Crossref's "polite pool").

## Data directory

```
bookshelf.db        SQLite: metadata, tags, authors, review queue, caches
covers/{id}.jpg     cover (≤1200×1800) and {id}.thumb.webp (≤320×480)
```

Back up the data directory to keep metadata you confirmed or edited; the books themselves are just your files.

## Development

```sh
bun test            # unit + integration tests (temp directories, recorded HTTP fixtures; no network)
bun run typecheck
```

`PLAN.md` documents the design decisions. Layout:

```
src/server/   Bun.serve entry, API routes, services, library index/scanner/watcher, extractors, metadata sources
src/web/      React app (pages, components, API client/hooks)
src/shared/   types shared by both
tests/        bun test suites, fixture generators, recorded API responses
```
