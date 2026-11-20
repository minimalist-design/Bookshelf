-- What a request costs against a service's daily quota (an ISBNdb bulk call costs one per ISBN).
ALTER TABLE http_calls ADD COLUMN cost INTEGER NOT NULL DEFAULT 1;
