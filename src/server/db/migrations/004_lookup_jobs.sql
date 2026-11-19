-- Bulk metadata lookups waiting to run, and the results of the current run (kept so its
-- progress survives restarts; finished rows are cleared when the next run starts).
CREATE TABLE lookup_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'no_match', 'failed')),
  error       TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX lookup_jobs_state ON lookup_jobs (state, id);
