# Bookshelf

A self-hosted book manager for a directory of e-books: a Bun + TypeScript server with an HTTP API, and SQLite. The
API ([docs/api.md](docs/api.md)) is the only interface; there is no web UI.

**The filesystem is the library.** The chosen root directory is the library, each folder directly inside it is a
bookshelf, and files directly in the root are *Unshelved*. The database stores metadata only — never *which* books
exist. Delete a file in your file manager and it disappears from the library; copy one in and it appears.

## Features

- EPUB, PDF, CBZ, CBR, DJVU and FB2 (`.fb2`, `.fb2.zip`, `.fbz`).
- Metadata from the file (EPUB OPF, PDF Info/XMP, ComicInfo.xml, DJVU, FB2), else from the filename
  (`Title -- Author -- isbn13 … -- doi …`), merged per field.
- One book can have several files (EPUB + PDF of the same ISBN/DOI are one book).
- Live updates: a recursive watcher picks up files added, moved, renamed or removed outside the app.
- Upload with duplicate detection; imported files are renamed `Author - Title [ISBN or DOI].ext`.
- Full-text search, filters (format, tag, series, author, rating, missing data…), sorting, paging.
- Editing (tags, series, rating, notes, cover…), merge/split, move between shelves, delete, file download.
- Metadata lookups in ISBNdb (with an API key), Open Library and the DOI registries (Crossref, doi.org/DataCite) with
  a field-by-field review, bulk lookups and a review queue.
- Live events over a WebSocket (`/ws`): library status, changed books, lookup progress.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer.
- Optional tools (detected at startup, listed in `GET /api/settings`):
  - `7z` (7-Zip) or `unrar` — CBR metadata, covers and reading.
  - `djvused`, `ddjvu` (djvulibre) — DJVU metadata, covers and reading.
  - `pdftoppm` (poppler) — PDF cover images.

  Without them those files are still listed, using their filename.

## Running

```sh
bun install
bun run dev        # development: hot reload (the URL is printed at startup)
bun run start      # production
bun run build      # single-file executable in dist/ (see below)
```

Until a library directory is set, the library is empty. Set it with `PUT /api/settings` and
`{"libraryRoot": "/path", "createLibraryRoot": true}` (`createLibraryRoot` creates a missing directory, parents
included); `{"libraryRoot": null}` unlinks it (no files are deleted). Or fix it with `library_root` in the config file:
a missing directory given there is created the first time the server starts with it; afterwards a missing directory is
reported as unavailable (e.g. an unmounted drive).

### Upgrading from the version with the web UI

That version's database can't be read: the schema was started over. Before running the new binary, stop the service and
delete the data directory (`~/.local/share/bookshelf` unless `data_dir` says otherwise; the server refuses to start
while the old database is there). In `make install`, choose **Replace** for the config (its `port` is kept).

### Configuration

Settings live in `~/.config/bookshelf/config.json` (`$XDG_CONFIG_HOME` is honoured), installed by `make install` from
[`config.template.json`](config.template.json). Without the file the defaults below are used; empty values mean the
default too. Paths may start with `~`.

| Setting | Default | Meaning |
|---|---|---|
| `version` | — | Config format version; see `bookshelf config version` |
| `library_root` | — | Library directory; overrides (and locks) the `libraryRoot` setting |
| `data_dir` | `$XDG_DATA_HOME/bookshelf` or `~/.local/share/bookshelf` | Database and cover images (must not be inside the library) |
| `host` | `0.0.0.0` | Bind address |
| `port` | `0` | HTTP port; `0` means not assigned yet (see [Port](#port)) |
| `max_upload_mb` | `16384` | Largest accepted upload |
| `isbndb_daily_limit` | `5000` | ISBNdb calls per day (your plan's quota) |
| `isbndb_per_second` | `1` | ISBNdb requests per second (your plan's rate) |

```sh
bookshelf config path       # where the config file is
bookshelf config template   # the default config
bookshelf config version    # the file's version and the current one
bookshelf config update     # add settings that are new in this version (never changes existing ones)
```

The server warns at startup when the config is older than the current version. (In development, use
`bun src/server/index.ts config …`.)

Secrets go in an env file outside the repo and `~/.config` (default `~/.secrets/bookshelf.env`, mode 600), given to
the service with systemd's `EnvironmentFile=`. [`.env.example`](.env.example) lists them:

| Variable | Meaning |
|---|---|
| `ISBNDB_API_KEY` | [ISBNdb](https://isbndb.com) API key. Optional: without it, lookups use Open Library and the DOI registries |

In development, `bun` reads a `.env` file in the project directory (ignored by git). Tests never use a real key.

#### Port

The first start picks the first free port from 20000 to 20999 and writes it into the config as `port` (only that value
changes; the rest of the file is left as it was). From then on Bookshelf always uses that port: if another program
has taken it, Bookshelf exits with an error naming it instead of moving elsewhere. To change it, edit `port` by hand.

#### Service info

`bookshelf serviceman-info` prints what [ServiceMan](https://github.com/objectiveprover/ServiceMan) and
[CaddyMan](https://github.com/objectiveprover/CaddyMan) need to set Bookshelf up: the command, port (`null` before the
first start), health-check path, config and env file, and suggested reverse proxy settings. `bookshelf caddyman-info`
is the same command (each tool asks with its own name). It reads only the config file, so it works before the service
has ever run.

The health-check path, `/api/health`, answers `200` while the server and its database work and `503` otherwise; it's
what ServiceMan polls.

> **There is no authentication.** Bookshelf is meant for a single user on a trusted network. Do not expose it to
> the internet without putting it behind an authenticating reverse proxy (which must also forward the `/ws`
> WebSocket).

## Standalone executable and service

`make build` compiles the server and the Bun runtime into a single self-contained executable, `./bookshelf`
(~110 MB), which needs neither Bun nor `node_modules` to run. It is built for the current
platform (`bun run build --target=linux-arm64 --outfile=dist/bookshelf-arm64` cross-compiles). It always runs in
production mode. The optional tools are still found on `PATH`.

```sh
make install      # build, then install ~/.local/bin/bookshelf, the config and the env file
make uninstall    # remove ~/.local/bin/bookshelf (config and env file are kept)
make clean        # remove ./bookshelf
```

`make install`:

- copies `config.template.json` to `~/.config/bookshelf/config.json` if there is none. If there is one, it asks:
  **Update** it (default: `bookshelf config update` adds new settings and changes nothing else), **Keep** it, or
  **Replace** it with the template after backing it up as `config.json.YYYYMMDD-HHMMSS.bak` (the old `port` is kept).
  Without a terminal the existing config is always kept.
- asks where the env file goes (default `~/.secrets/bookshelf.env`), creates the directory if needed (`~/.secrets`
  with mode 700) and copies `.env.example` there with mode 600 if there is none. If there is one, it asks:
  **Update** it (default: appends the variables from `.env.example` it lacks, with empty values; existing lines stay
  as they are), **Keep** it, or **Replace** it with `.env.example`, keeping the values of the variables still listed
  there. No backup of the env file is ever made, since it holds secrets, and only variable names are printed.
  Without a terminal the existing env file is always kept.
- doesn't create or restart a systemd unit: the service is managed with serviceman (give it the env file in the New
  service form or with `M-x set-env-file`), which restarts it when the binary in `~/.local/bin` is replaced.
  [`contrib/bookshelf.service`](contrib/bookshelf.service) is a plain systemd user unit for use without serviceman.

At startup pdf.js prints warnings about `@napi-rs/canvas`, `DOMMatrix` and `Path2D`. They are harmless: the server
only reads PDF metadata and never renders with pdf.js.

## How it behaves

### Filenames

- **Import pattern** (files you add): `Title -- Author[, Author…][ -- anything]` plus optional `isbn13 9780…` and/or
  `doi 10.xxxx_yyy` anywhere. DOIs use `_` instead of `/` (filenames cannot contain `/`). Extra ` -- ` segments, as in
  Anna's Archive names, are ignored. Authors may be separated by `,`, `;`, `&` or `and`; `Last, First` is understood.
- **Library pattern** (files the app names): `Author - Title [9780131103627].epub`, `A & B - Title …`,
  `A et al. - Title [10.1145_3290605.3300857].pdf`. ` (2)` is added on collisions.
- **`Title - Author`** names (common in downloads) are recognized: without an ID bracket, the split (at any ` - `) and
  which side is the author come from which side reads as a person's name (`Fokkinga M M`, `Jane Austen`, an author
  already in the library) and which as a title (lowercase words, articles, `Introduction`, `Part`…). When it can't
  tell, the app's own `Author - Title` order is used. Names with an ID bracket are always read in the app's order.
  Embedded metadata with the title and author swapped, or with the title copied into Author, is fixed the same way.
- `GET /api/cleanup/swaps` lists unconfirmed books that look stored the wrong way round, with a fix (read again from
  the filename when possible) that can be edited before `POST`ing it back; their files are renamed to match.
- Hand-copied files keep their names until they're normalized (`/api/books/normalize-filenames`, per book, or a whole
  shelf with `/api/maintenance/normalize`).

### Metadata, confirmation and retention

- Each file is linked to its metadata by SHA-256 content hash (with a hash cache keyed by path/size/mtime), falling
  back to the ISBN/DOI. Renaming or moving files therefore never loses metadata.
- Metadata is **confirmed** when accepted from Open Library / a DOI registry, or when you edit anything manually.
- When a book's last file disappears (deleted in the app *or* outside it): confirmed metadata is **kept** (and
  reconnected if the file returns); unconfirmed metadata is removed — it can always be re-read from the file.
  Removals outside the app wait 10 s so that moves are not mistaken for deletions, and a scan that finds an empty
  library (e.g. an unmounted drive) never removes anything.
- Editing title, authors or ISBN/DOI renames the book's files. File contents are never modified.
- Built-in **metadata rules** (`src/server/metadata/rules.ts`) reorganize what some publishers put in the wrong
  fields: e.g. a Delphi Classics book tagged "Parts Edition 3 of 12" gets series *Parts Edition*, number 3 (the tag is
  dropped), and the Delphi website is removed from its description. They apply to imported files and lookup results;
  `POST /api/maintenance/rules` applies them to unconfirmed books already in the library.

### Importing

`POST /api/import` takes one file as the request body and copies it into the chosen shelf. An identical file, or the
same ISBN/DOI in the same format, is rejected as a duplicate; a new format of an existing book is placed next to its
other files. With `lookup=1` a new book is queued for a metadata lookup, whose results go to the review queue.
Files can also simply be copied into the library directory: the watcher picks them up.

### Shelves

Shelves are created, renamed and deleted through `/api/shelves`. Deleting a shelf never deletes books: they move to
Unshelved. If the folder holds other (non-book) files, nothing is changed and the answer lists them.

### Lookups

A lookup (`GET /api/lookup/:id`) searches by ISBN or DOI (Crossref, then doi.org), else by title/author. The ISBNdb
records already kept in the database answer first (no call), then Open Library. Each candidate comes with a
field-by-field diff (`fill` for missing fields, `conflict` for differing ones); `POST /api/books/:id/apply-metadata`
applies the chosen fields. Bulk lookups (`POST /api/lookup/bulk`) fill the review queue. `GET /api/settings` says
whether ISBNdb is set up, and `GET /api/isbndb/key` the plan and quota ISBNdb reports for the key.

ISBNdb's API is paid per call, so it is asked only when a lookup names it (`source=isbndb`): automatic and bulk lookups
never call it. It has a daily quota (by default
5,000 calls, reset at 00:00 UTC). Bookshelf counts the calls it makes and also reads what ISBNdb reports as left (calls made elsewhere with the same key
count there): once either reaches zero it stops asking ISBNdb until the next day, and lookups carry on with Open
Library. `GET /api/metadata-usage` shows today's ISBNdb calls against the limit.

Every record ISBNdb sends is kept in the database for good, exactly as sent (every field, including other editions'
ISBNs, Thema subjects, genres and dimensions), whether or not the book is in the library: a title search asks for 100
results (it costs one call either way) and keeps them all, wrong books included. Lookups read that copy first, even
without a key:

- by ISBN: a book ISBNdb already sent, by any lookup or search, is answered from the copy;
- by title and author: a kept record answers when it has exactly that title (subtitle aside) by an author with that
  surname; for typed text, when its title is the text without its authors' names (so "Dune" isn't answered by a kept
  *Dune Messiah*). Candidates read from the copy have `kept: true`.

A lookup with `source=isbndb` asks ISBNdb itself and keeps its newer answer. ISBNs ISBNdb doesn't have are only
remembered for a day, since it often adds books within hours.

Each kept record's cover image is downloaded too, into `isbndb-covers/` in the data directory, placeholders included
(ISBNdb can't say which covers are placeholders). Downloads run in the background, behind everything else, and cost no
API quota; the full-size image is fetched while its temporary link is valid (2 hours), else the 450 px one. Applying an
ISBNdb cover to a book uses the downloaded file. Clearing the lookup cache (`DELETE /api/maintenance/http-cache`)
touches neither records nor covers; `GET /api/maintenance/stats` shows how many are kept. The API is described in
[`docs/isbndb-openapi.json`](docs/isbndb-openapi.json).

Requests stay under each service's published rate limit: one at a time per service, about 1 per second (ISBNdb as
set in `isbndb_per_second`, and slower when its rate-limit headers say the window is spent; Open Library
and Crossref allow about 2 per second once you set a contact email (`contactEmail` in `PUT /api/settings`), which also puts you in Crossref's
"polite pool"). A lower limit advertised in Crossref's response headers takes precedence. Responses are cached for a
week. If a service still answers *429 Too Many Requests*, nothing more is sent to it until its `Retry-After` time (or
1 minute, doubling while it keeps refusing).

Bulk lookups work through a queue stored in the database, one book at a time, so a large run takes a while and survives
restarts. `GET /api/lookup/status` (and `lookup.status` events) shows how far it is and roughly how long is left. When a service rate-limits
the queue, it pauses until the service accepts requests again and then continues, without counting the book as failed.
The run can be stopped at any time (`/api/lookup/cancel`), and the failed books retried (`/api/lookup/retry-failed`).

### Reference data

Databases of authors and books from other sources, one SQLite file per source, in a format that doesn't depend on the
source ([docs/reference-data-format.md](docs/reference-data-format.md)). A script per source builds the file; import it
through `/api/reference`, by uploading it or by giving its path on the server (better for big files, which can
exceed the upload limit). Bookshelf keeps its own copy as `reference/<source>.sqlite` in the data directory: importing
a newer file of the same source replaces it, and the library database isn't touched. Names and titles in every
language sit side by side, and each file keeps the raw responses it was made from.

**Wikidata.** `scripts/wikidata/build.ts` lists people known to Open Library, writers, works with an author and editions
of works (SPARQL), then fetches each one, and what it refers to (authors, series, editions, publishers), from the
Wikidata API:

```sh
bun scripts/wikidata/build.ts run wikidata.sqlite --langs en,es,ru --contact you@example.org
bun scripts/wikidata/build.ts status wikidata.sqlite
```

It takes many hours. Stop it at any time (Ctrl+C) and run the same command to resume; it marks the file complete when
nothing is left. `--langs` (default: all languages) is fixed when the file is created; `--contact` goes in the
User-Agent, as Wikimedia asks of automated clients; `--max-requests <n>` stops after n requests, to try it out.
`normalize` rebuilds the rows from the stored responses without the network (`--partial` marks an unfinished file
complete, to try it in Bookshelf). `bun scripts/reference-check.ts <file>` checks a file the way the import does. To
update the data, build a new file and import it.

## Data directory

```
bookshelf.db                SQLite: metadata, tags, authors, review queue, kept ISBNdb records, caches
covers/{id}.jpg             cover (≤1200×1800) and {id}.thumb.webp (≤320×480)
isbndb-covers/{isbn13}.jpg  cover image of each kept ISBNdb record, as ISBNdb serves it
reference/{source}.sqlite   imported reference data (authors and books from Wikidata and other sources)
```

Back up the data directory to keep metadata you confirmed or edited, and the ISBNdb records and covers the daily quota
paid for; the books themselves are just your files.

## Development

```sh
bun test            # unit + integration tests (temp directories, recorded HTTP fixtures; no network)
bun run typecheck
```

Layout:

```
src/server/   Bun.serve entry, API routes, services, library index/scanner/watcher, extractors, metadata sources
src/shared/   API types (request and response shapes)
tests/        bun test suites, fixture generators, recorded API responses
```
