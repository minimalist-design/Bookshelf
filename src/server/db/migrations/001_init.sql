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
  rating           INTEGER CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  notes            TEXT,
  has_cover        INTEGER NOT NULL DEFAULT 0,
  cover_source     TEXT,     -- 'embedded' | 'openlibrary' | 'doi' | 'upload'
  ol_edition_key   TEXT,
  ol_work_key      TEXT,
  metadata_source  TEXT,     -- 'embedded' | 'filename' | 'mixed'
  confirmed_source TEXT,     -- NULL | 'openlibrary' | 'doi' | 'manual'
  confirmed_at     TEXT,
  reading_position TEXT,
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

CREATE TABLE http_cache (
  url        TEXT PRIMARY KEY,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
