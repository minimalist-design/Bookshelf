-- Spelling variants merged into one name (Settings › Clean up names). New imports and lookups
-- get `canonical` for any name whose folded form (case, accents, spacing removed) is `variant`.
CREATE TABLE aliases (
  field     TEXT NOT NULL,   -- 'authors' | 'tags' | 'series' | 'publishers'
  variant   TEXT NOT NULL,   -- folded form of the variant
  name      TEXT NOT NULL,   -- the variant as it was written, for display
  canonical TEXT NOT NULL,
  PRIMARY KEY (field, variant)
);
