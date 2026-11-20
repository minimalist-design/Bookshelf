-- Requests sent to metadata services (not cache hits), for the usage summary; pruned after a day.
CREATE TABLE http_calls (
  host TEXT NOT NULL,
  at   INTEGER NOT NULL -- epoch ms
);
CREATE INDEX http_calls_host_at ON http_calls (host, at);

-- Lookup runs: finished jobs of earlier runs are kept for a while (so the Add books page can
-- still read a book's outcome) instead of being deleted when a new run starts.
ALTER TABLE lookup_jobs ADD COLUMN run INTEGER NOT NULL DEFAULT 0;
CREATE INDEX lookup_jobs_run ON lookup_jobs (run);
