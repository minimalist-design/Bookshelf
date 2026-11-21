-- Metadata only: no table records which books exist in the library.
-- Presence is determined exclusively by files on disk.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE books (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  sort_title       TEXT,
  subtitle         TEXT,
  isbn13           TEXT,
  doi              TEXT,
  publisher        TEXT,
  published_date   TEXT,
  year             INTEGER,
  language         TEXT,
  pages            INTEGER,
  description      TEXT,
  series           TEXT,
  series_index     REAL,
  -- Edition statement as printed ("2nd", "Revised", "25th Anniversary Edition"); free text, not a number.
  edition          TEXT,
  rating           INTEGER CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  notes            TEXT,
  has_cover        INTEGER NOT NULL DEFAULT 0,
  cover_source     TEXT,     -- 'embedded' | 'openlibrary' | 'doi' | 'upload'
  ol_edition_key   TEXT,
  ol_work_key      TEXT,
  metadata_source  TEXT,     -- 'embedded' | 'filename' | 'mixed'
  confirmed_source TEXT,     -- NULL | 'openlibrary' | 'doi' | 'manual'
  confirmed_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX books_isbn13 ON books(isbn13);
CREATE INDEX books_doi ON books(doi);

-- Content hashes of every file version known to belong to a book (one book, many files/formats).
CREATE TABLE book_hashes (
  hash    TEXT PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format  TEXT NOT NULL
);
CREATE INDEX book_hashes_book ON book_hashes(book_id);

CREATE TABLE authors (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  sort_name TEXT
);

CREATE TABLE book_authors (
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (book_id, author_id)
);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE book_tags (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

-- rowid = books.id; maintained by repository code.
CREATE VIRTUAL TABLE books_fts USING fts5(
  title, subtitle, authors, isbn13, doi, series, tags, description,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Pure cache to avoid re-hashing unchanged files. Never used to list books; pruned on each full scan.
CREATE TABLE file_hash_cache (
  path     TEXT PRIMARY KEY,
  size     INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  hash     TEXT NOT NULL
);

-- Requests sent to metadata services, for the usage summary; pruned after a day.
CREATE TABLE http_calls (
  host TEXT NOT NULL,
  at   INTEGER NOT NULL,           -- epoch ms
  cost INTEGER NOT NULL DEFAULT 1  -- what it was charged against the service's daily quota (0 for cover images)
);
CREATE INDEX http_calls_host_at ON http_calls (host, at);

-- Lookup results waiting for review (bulk lookups). Candidates only; diffs are recomputed against
-- the current metadata when read.
CREATE TABLE review_queue (
  book_id    INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Bulk metadata lookups waiting to run, and their results (kept so progress survives restarts).
-- Finished jobs of earlier runs are kept for a while, so a book's outcome can still be read.
CREATE TABLE lookup_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'no_match', 'failed')),
  error       TEXT,
  run         INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX lookup_jobs_state ON lookup_jobs (state, id);
CREATE INDEX lookup_jobs_run ON lookup_jobs (run);

-- Every book record received from ISBNdb, kept for good: a local copy of what the daily quota paid for,
-- whether or not the book is in the library (search results that were the wrong book included).
-- Lookups read it before asking ISBNdb. Nothing expires or clears it.
-- Cover images are downloaded into <data dir>/isbndb-covers (placeholders too).
CREATE TABLE isbndb_records (
  isbn13      TEXT PRIMARY KEY,
  title       TEXT,
  authors     TEXT NOT NULL DEFAULT '[]', -- JSON array, for finding records by name
  record      TEXT NOT NULL,              -- the record exactly as ISBNdb sent it (JSON, every field)
  via         TEXT NOT NULL,              -- the call it came from: 'book' | 'search'
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- NULL still to download · 'done' · 'none' the record has no image · 'failed' gave up.
  cover_state TEXT,
  cover_file  TEXT,                       -- file name in that directory
  cover_bytes INTEGER
);
CREATE INDEX isbndb_records_title ON isbndb_records (title COLLATE NOCASE);
CREATE INDEX isbndb_records_cover_pending ON isbndb_records (fetched_at) WHERE cover_state IS NULL;
