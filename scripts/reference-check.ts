#!/usr/bin/env bun
/**
 * Checks a reference file the way Bookshelf does before importing it (docs/reference-data-format.md).
 *
 *   bun scripts/reference-check.ts <file.sqlite>
 *
 * Exit status 0 when Bookshelf would import it, 1 otherwise.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { checkReferenceDb, countRows, readMeta } from "../src/server/reference/format.ts";

const file = Bun.argv[2];
if (!file || !existsSync(file)) {
  console.error("usage: bun scripts/reference-check.ts <file.sqlite>");
  process.exit(2);
}

const db = new Database(file, { readonly: true });
try {
  const problems = checkReferenceDb(db, { requireComplete: true });
  if (problems.length) {
    console.log(`Bookshelf wouldn't import ${file}:`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  const meta = readMeta(db);
  const c = countRows(db);
  console.log(`OK: ${meta.source_name ?? meta.source} (${meta.source_version ?? "no version"}), languages ${meta.languages ?? "not given"}`);
  console.log(`${c.authors} authors, ${c.works} works, ${c.series} series, ${c.editions} editions, ${c.rawResponses} raw responses`);
} finally {
  db.close();
}
