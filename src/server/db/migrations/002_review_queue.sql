-- Lookup results waiting for the user's review (bulk lookups). Candidates only; diffs are
-- recomputed against the current metadata when read.
CREATE TABLE review_queue (
  book_id    INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
