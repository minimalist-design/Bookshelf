# Reference data format

Bookshelf can use databases of authors and books from other sources (Wikidata, ISBNdb, Open Library…) to
recognise authors, their other spellings and their works. Each source has its own **reference file**: one
SQLite database in the format described here. The format doesn't depend on the source:

- a **builder** (a script such as `scripts/wikidata/build.ts`, or Bookshelf itself for the services it asks)
  knows its source and writes the file;
- **Bookshelf** only knows this format. It imports a finished file in *Settings › Reference data* and keeps it
  next to its own database, at `<data dir>/reference/<source>.sqlite`. Importing a newer file for the same
  source replaces the old one; the library database is never touched.

Format name `bookshelf-reference`, version **1**.

## The file

- A single SQLite 3 file, not in WAL mode (`PRAGMA journal_mode = DELETE`), so it can be copied as one file.
- Text is UTF-8. Dates are ISO 8601 (`2026-11-20T18:00:00Z`; published dates may be just `1866` or `1866-01`).
- Years are integers, negative before the common era: `-428` for 428 BC (no year 0, as Wikidata writes them).
- Every table below exists, even when empty. Columns marked *optional* may be NULL.
- Builders may add their own tables (for example to resume a build). Their names start with `build_`;
  Bookshelf ignores them. Bookshelf adds its own tables to its copy of the file, starting with `bookshelf_`.

### Versions

`meta.format_version` changes only when a table or column is renamed or removed, or its meaning changes.
Adding a table or an optional column keeps the version. Bookshelf refuses a version it doesn't know.

## Tables

### `meta`

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

| key | required | value |
|---|---|---|
| `format` | yes | `bookshelf-reference` |
| `format_version` | yes | `1` |
| `source` | yes | Short lowercase name: letters, digits, `-` (`wikidata`, `isbndb`). Names the imported file. |
| `status` | yes | `building` while the builder works, `complete` once finished. Only complete files are imported. |
| `source_name` | | Shown to the user (`Wikidata`). |
| `source_url` | | The source's home page. |
| `source_version` | | Which state of the source the file reflects (a dump date, or the date fetching started). |
| `built_at` | | When the file was completed. |
| `languages` | | The language codes the builder kept for names and titles, comma-separated; `*` for all. |
| `license` | | License of the data, as an SPDX identifier where there is one (`CC0-1.0`). |
| `builder` | | The program that built the file, with its version. |

### IDs

Every row is identified by the **source's own ID**, as text (`Q991` on Wikidata, `OL22242A` on Open Library).
When the source has none (ISBNdb gives authors only as names), the builder derives a stable one, the same
for the same thing in every build (e.g. `name:fyodor dostoyevsky`). An ID is unique within its table.

### Languages

Names and titles carry a `lang` column: a language code as the source gives it (`en`, `ru`, `pt-br`,
`zh-hans`; Wikidata's `mul` for a name that is the same in many languages), or `''` when unknown. No language
is special. The main row of an author or work also has one display name, the builder's choice (Wikidata:
English when there is one, then `mul`, then the first available); every name in every language, the display
name included, is listed in the names table.

### People: `authors`, `author_names`

Everyone credited on a work: authors, editors, translators, illustrators, pseudonyms and house names.

```sql
CREATE TABLE authors (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,   -- display name
  sort_name   TEXT,            -- optional: 'Dostoyevsky, Fyodor'
  description TEXT,            -- optional: short text telling people of the same name apart
  birth_year  INTEGER,         -- optional
  death_year  INTEGER,         -- optional
  prominence  INTEGER          -- optional: higher is better known (Wikidata: number of sitelinks)
);
CREATE TABLE author_names (
  author_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL,     -- see below
  PRIMARY KEY (author_id, name, lang, kind)
);
```

`kind`: `name` (the name in that language), `alias` (another way of writing it: `F. M. Dostoevsky`),
`pseudonym`, `birth_name`, `native` (in the person's own language and script).

### Works: `works`, `work_titles`, `work_authors`

A work is the book as written, whatever the edition or translation (*Crime and Punishment*).

```sql
CREATE TABLE works (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,  -- display title
  description   TEXT,           -- optional
  first_year    INTEGER,        -- optional: first publication
  original_lang TEXT,           -- optional: language it was written in
  series_id     TEXT,           -- optional: series.id
  series_index  REAL,           -- optional: its number in the series
  prominence    INTEGER         -- optional
);
CREATE TABLE work_titles (
  work_id TEXT NOT NULL,
  title   TEXT NOT NULL,
  lang    TEXT NOT NULL DEFAULT '',
  kind    TEXT NOT NULL,        -- 'title' | 'alias' | 'original' (as first published)
  PRIMARY KEY (work_id, title, lang, kind)
);
CREATE TABLE work_authors (
  work_id   TEXT NOT NULL,
  author_id TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'author',  -- 'author' | 'editor' | 'translator' | 'illustrator' | 'contributor'
  position  INTEGER NOT NULL,                -- order of the credits, from 0
  PRIMARY KEY (work_id, author_id, role)
);
```

A credit whose person the source doesn't identify is left out.

### Series: `series`, `series_names`

```sql
CREATE TABLE series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT              -- optional
);
CREATE TABLE series_names (
  series_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL,      -- 'name' | 'alias'
  PRIMARY KEY (series_id, name, lang, kind)
);
```

### Editions: `editions`, `edition_authors`

A particular publication of a work, where ISBNs belong. Sources that only know editions (ISBNdb) leave
`work_id` empty and credit the people on the edition.

```sql
CREATE TABLE editions (
  id             TEXT PRIMARY KEY,
  work_id        TEXT,          -- optional: works.id
  title          TEXT,          -- optional (then the work's)
  subtitle       TEXT,          -- optional
  publisher      TEXT,          -- optional: the publisher's name
  published_date TEXT,          -- optional: '1866', '1866-01' or '1866-01-14'
  year           INTEGER,       -- optional
  lang           TEXT,          -- optional
  pages          INTEGER,       -- optional
  binding        TEXT,          -- optional: as the source says ('Paperback', 'Kindle Edition')
  description    TEXT           -- optional: synopsis
);
CREATE TABLE edition_authors (
  edition_id TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'author',
  position   INTEGER NOT NULL,
  PRIMARY KEY (edition_id, author_id, role)
);
```

### `identifiers`

IDs the same thing has elsewhere, for any row above.

```sql
CREATE TABLE identifiers (
  entity    TEXT NOT NULL,     -- 'author' | 'work' | 'series' | 'edition'
  entity_id TEXT NOT NULL,
  scheme    TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, scheme, value)
);
CREATE INDEX identifiers_value ON identifiers (scheme, value);
```

Schemes, with values written as below so they can be compared:

| scheme | value |
|---|---|
| `isbn13` | 13 digits, no hyphens |
| `isbn10` | 10 characters, no hyphens, `X` upper case |
| `doi` | lower case, without `https://doi.org/` |
| `wikidata` | `Q991` |
| `openlibrary` | `OL22242A`, `OL1234W`, `OL5678M` |
| `viaf`, `loc`, `gnd`, `isni`, `oclc`, `lccn`, `goodreads`, `librarything`, `gutenberg` | as the source writes them, ISNI without spaces |

Other schemes may be used: short lowercase names.

### Raw responses: `raw_responses`, `record_sources`

Every response the builder received, exactly as it came, so that a later version of the builder (or of
Bookshelf) can read more out of it without asking the source again.

```sql
CREATE TABLE raw_responses (
  id           INTEGER PRIMARY KEY,
  url          TEXT NOT NULL,   -- without secrets: keys go in headers, never in the URL
  method       TEXT NOT NULL DEFAULT 'GET',
  request_body TEXT,            -- optional: for POST
  status       INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL,
  content_type TEXT,            -- optional
  encoding     TEXT NOT NULL,   -- 'identity' | 'gzip': how `body` is stored
  body         BLOB NOT NULL
);
CREATE TABLE record_sources (
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  response_id INTEGER NOT NULL, -- raw_responses.id
  PRIMARY KEY (entity, entity_id, response_id)
);
```

`record_sources` says which responses a row was made from. A builder that rebuilds its rows from the raw
responses (`scripts/wikidata/build.ts normalize`) needs no network.

## Writing a builder

1. Create the file with the schema (`createReferenceSchema` in `src/server/reference/format.ts` does it for
   scripts in this repository), and set `meta` with `status = building`.
2. Store each response in `raw_responses` and the rows made from it in the same transaction, so that the build
   can be stopped at any point and resumed.
3. When done: set `status = complete` and `built_at`, and `PRAGMA journal_mode = DELETE`.

Bookshelf checks, before importing: the required `meta` keys and values, every table and column above, and that
it's a SQLite file. `bun scripts/reference-check.ts <file>` runs the same checks.
