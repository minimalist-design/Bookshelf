-- Every book record received from ISBNdb, kept for good: a local copy of what the daily quota paid for,
-- whether or not the book is in the library (search results that were the wrong book included).
-- Lookups read it before asking ISBNdb. Unlike http_cache, nothing expires or clears it.
CREATE TABLE isbndb_records (
  isbn13     TEXT PRIMARY KEY,
  title      TEXT,
  authors    TEXT NOT NULL DEFAULT '[]', -- JSON array, for finding records by name
  record     TEXT NOT NULL,              -- the record exactly as ISBNdb sent it (JSON, every field)
  via        TEXT NOT NULL,              -- the call it came from: 'book' | 'bulk' | 'search'
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX isbndb_records_title ON isbndb_records (title COLLATE NOCASE);
