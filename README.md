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
bun run dev        # development: hot reload (the URL is printed at startup)
bun run start      # production
bun run build      # single-file executable in dist/ (see below)
```

On first start the web UI asks for the library directory (a server-side folder browser, which can also create
folders). A typed path that doesn't exist yet is created, including missing parent folders. It can be changed later in
*Settings*, or removed there (only the link is dropped — no files are deleted — and the first-start screen is shown
again), or fixed with `library_root` in the config file — a missing directory given there is created the first time
the server starts with it; afterwards a missing directory is reported as unavailable (e.g. an unmounted drive).

### Configuration

Settings live in `~/.config/bookshelf/config.json` (`$XDG_CONFIG_HOME` is honoured), installed by `make install` from
[`config.template.json`](config.template.json). Without the file the defaults below are used; empty values mean the
default too. Paths may start with `~`.

| Setting | Default | Meaning |
|---|---|---|
| `version` | — | Config format version; see `bookshelf config version` |
| `library_root` | — | Library directory; overrides (and locks) the UI setting |
| `data_dir` | `$XDG_DATA_HOME/bookshelf` or `~/.local/share/bookshelf` | Database and cover images (must not be inside the library) |
| `host` | `0.0.0.0` | Bind address |
| `port` | `0` | HTTP port; `0` means not assigned yet (see [Port](#port)) |
| `max_upload_mb` | `16384` | Largest accepted upload |

```sh
bookshelf config path       # where the config file is
bookshelf config template   # the default config
bookshelf config version    # the file's version and the current one
bookshelf config update     # add settings that are new in this version (never changes existing ones)
```

The server warns at startup when the config is older than the current version. (In development, use
`bun src/server/index.ts config …`.)

Secrets go in an env file outside the repo and `~/.config` (default `~/.secrets/bookshelf.env`, mode 600), given to
the service with systemd's `EnvironmentFile=`. Bookshelf needs no secrets, so [`.env.example`](.env.example) has no
variables.

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

`make build` compiles everything (server, web app, pdf.js assets and the Bun runtime) into a single self-contained
executable, `./bookshelf` (~115 MB), which needs neither Bun nor `node_modules` to run. It is built for the current
platform (`bun run build --target=linux-arm64 --outfile=dist/bookshelf-arm64` cross-compiles). It always runs in
production mode. The optional tools are still found on `PATH`.

```sh
make install      # build, then install ~/.local/bin/bookshelf, the config and the env file
make uninstall    # remove ~/.local/bin/bookshelf (config and env file are kept)
make clean        # remove ./bookshelf
```

`make install`:

- copies `config.template.json` to `~/.config/bookshelf/config.json` if there is none. If there is one, it asks:
  **Keep** it (default), **Update** it (`bookshelf config update`: adds new settings, changes nothing else), or
  **Replace** it with the template after backing it up as `config.json.YYYYMMDD-HHMMSS.bak` (the old `port` is kept).
  Without a terminal the existing config is always kept.
- asks where the env file goes (default `~/.secrets/bookshelf.env`), creates the directory if needed (`~/.secrets`
  with mode 700) and copies `.env.example` there with mode 600 — only if the file doesn't exist yet.
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

Requests stay under each service's published rate limit: one at a time per service, about 1 per second (Open Library
and Crossref allow about 2 per second once you set a contact email in *Settings*, which also puts you in Crossref's
"polite pool"). A lower limit advertised in Crossref's response headers takes precedence. Responses are cached for a
week. If a service still answers *429 Too Many Requests*, nothing more is sent to it until its `Retry-After` time (or
1 minute, doubling while it keeps refusing).

Bulk lookups work through a queue stored in the database, one book at a time, so a large run takes a while and survives
restarts. A progress bar above every page shows how far it is and roughly how long is left. When a service rate-limits
the queue, it pauses until the service accepts requests again and then continues, without counting the book as failed.
You can stop the run at any time, and retry the failed books from the review queue.

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

Layout:

```
src/server/   Bun.serve entry, API routes, services, library index/scanner/watcher, extractors, metadata sources
src/web/      React app (pages, components, API client/hooks)
src/shared/   types shared by both
tests/        bun test suites, fixture generators, recorded API responses
```
