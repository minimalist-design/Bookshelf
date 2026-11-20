-- Cover images of the kept ISBNdb records, downloaded into <data dir>/isbndb-covers (placeholders too).
-- cover_state: NULL still to download (records kept before this migration included) · 'done' ·
-- 'none' the record has no image · 'failed' gave up.
ALTER TABLE isbndb_records ADD COLUMN cover_state TEXT;
ALTER TABLE isbndb_records ADD COLUMN cover_file TEXT; -- file name in that directory
ALTER TABLE isbndb_records ADD COLUMN cover_bytes INTEGER;
CREATE INDEX isbndb_records_cover_pending ON isbndb_records (fetched_at) WHERE cover_state IS NULL;
