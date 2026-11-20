# Bookshelf

A self-hosted manager for a folder of e-books. Point it at the folder where you keep your books and it catalogues them,
reads their metadata, finds what's missing online, and keeps the filenames tidy. You use it through an HTTP API
(described in [docs/api.md](docs/api.md)); there is no web interface (yet).

**Your folder is the library.** Each folder directly inside it is a bookshelf, and books lying in the top folder are
*Unshelved*. Bookshelf never hides your files away: copy a book into the folder and it shows up, delete one in your file
manager and it's gone. What Bookshelf adds — titles, authors, tags, series, ratings, notes, covers — is kept separately,
so your files stay as they are.

## What it does

- Reads EPUB, PDF, CBZ, CBR, DJVU and FB2 (`.fb2`, `.fb2.zip`, `.fbz`).
- Takes each book's title, authors, ISBN or DOI and other details from the file itself, or from its filename when the
  file has none.
- Treats the EPUB and the PDF of the same book as one book with two files.
- Notices files you add, move, rename or remove outside Bookshelf, as it happens.
- Imports new books into a shelf, refuses duplicates, and names them `Author - Title [ISBN or DOI].ext`.
- Searches titles, authors, series, tags, descriptions, ISBNs and DOIs, with filters (format, tag, series, author, rating,
  missing data…) and sorting.
- Lets you edit a book's details and cover, merge two entries into one or split one apart, move books between shelves,
  delete them, and download their files.
- Looks books up in Open Library, Crossref and the other DOI registries, and in ISBNdb if you have an API key. You
  review each suggestion field by field before anything changes. Large batches go to a review queue.
- Sends live updates over a WebSocket (`/ws`): changed books, scan and lookup progress.

## Requirements

- To build it: [Bun](https://bun.sh) 1.4 or newer. The installed program doesn't need Bun.
- Optional tools, used when found on your `PATH`:
  - `7z` (7-Zip) or `unrar`, for CBR files;
  - `djvused` and `ddjvu` (djvulibre), for DJVU files;
  - `pdftoppm` (poppler), for PDF covers.

  Without them those books are still listed, with what their filenames say. `GET /api/settings` shows which tools were
  found.

## Installing

```sh
make install
```

This builds a single `bookshelf` executable, installs it to `~/.local/bin/`, and sets up two files:

- **The config file**, `~/.config/bookshelf/config.json`. If you already have one, you're asked whether to **Update**
  it (the default: adds settings that are new in this version and changes nothing else), **Keep** it, or **Replace** it
  with the defaults (the old file is backed up next to it, and its port is kept).
- **The secrets file** for your ISBNdb API key. You're asked where to put it (default `~/.secrets/bookshelf.env`, readable
  only by you). If it already exists you get the same Update / Keep / Replace choice; it's never emptied, and no
  copies of it are made.

Then start it:

```sh
bookshelf
```

To run it as a service, use [ServiceMan](https://github.com/objectiveprover/ServiceMan): it reads what it needs from
Bookshelf itself and restarts the service whenever you install a new version. Give it the secrets file as the
service's environment file. Without ServiceMan, [`contrib/bookshelf.service`](contrib/bookshelf.service) is a plain
systemd user unit.

`make uninstall` removes the program and leaves your config, secrets and data alone.

## First start

The first time it starts, Bookshelf picks a free port between 20000 and 20999, saves it in the config file and prints
the address. It uses that same port from then on; if another program has taken it, Bookshelf stops with an error rather
than moving. To change it, edit `port` in the config file.

Next, tell it where your books are, either with the API:

```sh
curl -X PUT http://localhost:20000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"libraryRoot": "/home/me/Books", "createLibraryRoot": true}'
```

or by setting `library_root` in the config file. Bookshelf then scans the folder; large libraries take a while the
first time, and `/ws` reports the progress. Unlinking the folder (`{"libraryRoot": null}`) never deletes any files.

If the folder disappears later (an unmounted drive, say), Bookshelf reports the library as unavailable and forgets
nothing.

> **There is no login.** Bookshelf is meant for one person on a trusted network. Don't expose it to the internet
> without an authenticating reverse proxy in front of it (one that also forwards the `/ws` WebSocket).
> [CaddyMan](https://github.com/objectiveprover/CaddyMan) can set one up from what Bookshelf tells it.

## Settings

The config file is `~/.config/bookshelf/config.json` (`bookshelf config path` prints it). Leaving a value empty means
the default.

| Setting | Default | Meaning |
|---|---|---|
| `library_root` | — | Your books folder. When set here, it can't be changed through the API |
| `data_dir` | `~/.local/share/bookshelf` | Where Bookshelf keeps its database and covers. Must not be inside the library |
| `host` | `0.0.0.0` | Network address to listen on (`127.0.0.1` for this computer only) |
| `port` | `0` | Port to listen on; `0` means "pick one on first start" |
| `max_upload_mb` | `16384` | Largest file you can import through the API |
| `isbndb_daily_limit` | `5000` | ISBNdb calls per day your plan allows |
| `isbndb_per_second` | `1` | ISBNdb requests per second your plan allows |

```sh
bookshelf config version    # is my config up to date?
bookshelf config update     # add settings that are new in this version
bookshelf config template   # show the defaults
```

Bookshelf warns at startup when the config is from an older version.

Your ISBNdb API key goes in the secrets file, never in the config:

```sh
ISBNDB_API_KEY=your-key
```

It's optional: without it, lookups use Open Library and the DOI registries.

## Using it

Everything below is done through the API; [docs/api.md](docs/api.md) has the details.

### Shelves

Create, rename and delete shelves, or just make and remove folders yourself. Deleting a shelf never deletes books:
they move to Unshelved. If the folder holds other files that aren't books, it's left alone and you're told which files
they are.

### Adding books

Import a book into a shelf through the API, or copy it into the library folder. An import is refused if the same file,
or the same ISBN or DOI in the same format, is already there; a new format of a book you have joins its other files.
You can ask for an imported book to be looked up straight away, with the results waiting in the review queue.

Files you copy in yourself keep their names until you ask Bookshelf to rename them, one book or a whole shelf at a time.

### Filenames

Bookshelf reads details from filenames like these:

- `Title -- Author, Other Author -- anything else isbn13 9780131103627 doi 10.1145_3290605.3300857`: the style used
  by Anna's Archive. Authors can be separated by `,`, `;`, `&` or `and`, and `Last, First` is understood. DOIs use `_`
  instead of `/`, since filenames can't contain `/`.
- `Author - Title [9780131103627].epub`: the style Bookshelf names files in. Several authors appear as
  `A & B - Title` or `A et al. - Title`, and ` (2)` is added when two names would collide.
- `Title - Author`, common in downloads: Bookshelf works out which side is the author and which the title. When it
  can't tell, it assumes `Author - Title`.

Some files have the title and author swapped in their own metadata. Bookshelf can list the books that look the wrong
way round and suggest a fix you can adjust before applying.

### Editing

Changing a book's title, authors, ISBN or DOI renames its files to match. The contents of your files are never changed:
covers, tags and other details live only in Bookshelf.

Some publishers put details in the wrong place (Delphi Classics, for example, files "Parts Edition 3 of 12" as a tag
instead of a series). Bookshelf fixes the ones it knows about when it reads them, and can apply those fixes to books
already in the library.

### Looking up metadata

Ask for a lookup on a book and Bookshelf searches by ISBN or DOI, or by title and author when there's neither. Each
suggestion shows which fields would fill in something missing and which would replace what you have; you choose which
to apply. A bulk lookup goes through many books in the background, and its suggestions wait in the review queue. It
continues after a restart, can be stopped at any time, and its failures can be retried.

Bookshelf stays within each service's published limits, so a large bulk lookup is slow on purpose: about a book a
second. Giving it a contact email (`contactEmail` in the settings) lets Open Library and Crossref serve it about twice
as fast.

**ISBNdb** charges per call, so Bookshelf only asks it when you ask for it on a lookup; bulk lookups never use it.
Bookshelf keeps count against your daily limit (and what ISBNdb says is left, which includes calls made elsewhere
with the same key), and stops using it until the next day once it's spent. Everything ISBNdb sends is kept for good,
covers included, so you never pay twice for the same answer, and later lookups use those records even without a key.

### What happens when you delete a book

Details you've confirmed — by accepting a lookup or editing anything yourself — are kept when a book's last file goes
away, and come back if the file returns. Details that were only read from the file are dropped, since they can be read
again. Renaming or moving files, inside Bookshelf or outside it, never loses anything.

## Author and book reference data

Bookshelf can import databases of authors and books from other sources, such as Wikidata, to learn names and titles
in every language. You build the database file with a script and import it through the API, by uploading it or by
giving its path on the server (better for large files). Importing a newer file from the same source replaces the old
one. The file format is described in [docs/reference-data-format.md](docs/reference-data-format.md).

To build the Wikidata file (this needs Bun and a copy of this repository):

```sh
bun install
bun scripts/wikidata/build.ts run wikidata.sqlite --langs en,es,ru --contact you@example.org
bun scripts/wikidata/build.ts status wikidata.sqlite
```

It takes many hours. Stop it with Ctrl+C whenever you like and run the same command again to carry on; the file is
marked complete when nothing is left.

- `--langs` picks the languages to keep (default: all). It's fixed when the file is first created.
- `--contact` is sent to Wikimedia, who ask automated tools to give a way to reach their owner.
- `--max-requests 100` stops after 100 requests, to try it out.
- `normalize --partial` marks an unfinished file complete, to try it in Bookshelf before the build is done.

`bun scripts/reference-check.ts wikidata.sqlite` checks a file the same way the import does.

## Backing up

Your books are just your files. Back up the data directory (`~/.local/share/bookshelf` by default) to keep the details
you've confirmed or edited, your covers, tags and notes, and the ISBNdb records you've paid for.

## Troubleshooting

- **Bookshelf won't start: the port is taken.** Another program is using the port saved in the config. Stop it, or
  set a different `port`.
- **Warnings about `@napi-rs/canvas`, `DOMMatrix` or `Path2D` at startup.** They're harmless and can be ignored.
- **CBR, DJVU or PDF books show no cover or details.** Install the optional tools listed under
  [Requirements](#requirements).
- **`/api/health`** answers `200` while Bookshelf and its database are working, and `503` otherwise.

## Development

```sh
bun install
bun run dev    # run from source with hot reload
bun test       # tests; no network needed
```
