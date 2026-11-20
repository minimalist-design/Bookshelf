import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../src/server/api/router.ts";
import { createApp, type AppContext } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { applyRules, type RuleFields } from "../src/server/metadata/rules.ts";
import { pickMetadata } from "../src/server/metadata/types.ts";
import { makeEpub } from "./fixtures.ts";

const delphi = (over: Partial<RuleFields> = {}): RuleFields => ({
  publisher: "Delphi Classics",
  tags: ["Fiction", "Parts Edition 3 of 12 by Delphi Classics"],
  description: "www.delphiclassics.com",
  series: null,
  seriesIndex: null,
  ...over,
});

describe("metadata rules: Delphi Classics parts editions", () => {
  test("the parts edition tag becomes the series and its number, and is dropped; the website-only description goes", () => {
    expect(applyRules(delphi())).toEqual({ publisher: "Delphi Classics", tags: ["Fiction"], description: null, series: "Parts Edition", seriesIndex: 3 });
  });

  test("tag and publisher are matched whatever the case and wording around them", () => {
    const r = applyRules(delphi({ publisher: "DELPHI CLASSICS Ltd", tags: ["parts edition 12 of 40"], description: null }));
    expect(r).toMatchObject({ series: "Parts Edition", seriesIndex: 12, tags: [] });
  });

  test("the website is removed from a longer description, the rest kept; a description that only names the publisher goes", () => {
    expect(applyRules(delphi({ description: "The complete novels.\n\nVisit https://www.delphiclassics.com/shop for more." })).description).toBe(
      "The complete novels.\n\nVisit for more.",
    );
    expect(applyRules(delphi({ description: "Delphi Classics – www.delphiclassics.com" })).description).toBeNull();
  });

  test("other publishers, and Delphi books with nothing to fix, are returned untouched (the same object)", () => {
    const other = delphi({ publisher: "Penguin" });
    expect(applyRules(other)).toBe(other);
    const clean = delphi({ tags: ["Fiction"], description: "A collection." });
    expect(applyRules(clean)).toBe(clean);
    const done = delphi({ tags: ["Fiction"], description: null, series: "Parts Edition", seriesIndex: 3 });
    expect(applyRules(done)).toBe(done);
  });

  test("an existing series is replaced by the parts edition", () => {
    expect(applyRules(delphi({ series: "Delphi Complete Works", seriesIndex: 1 }))).toMatchObject({ series: "Parts Edition", seriesIndex: 3 });
  });
});

describe("metadata rules in the library", () => {
  let tmp: string;
  let root: string;
  let app: AppContext;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bookshelf-rules-"));
    root = join(tmp, "library");
    mkdirSync(join(root, "S"), { recursive: true });
    app = createApp(loadConfig({ data_dir: join(tmp, "data") }), { library: { debounceMs: 30, stableMs: 80, graceMs: 60_000 } });
  });
  afterEach(async () => {
    await app.library.close();
    app.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const idOf = (rel: string) => app.library.index.get(rel)!.bookId;

  test("an imported Delphi Classics EPUB gets its parts edition as series and loses the website description", async () => {
    const epub = makeEpub({
      metadataXml: `
        <dc:title>Charles Dickens: The Pickwick Papers</dc:title>
        <dc:creator>Charles Dickens</dc:creator>
        <dc:publisher>Delphi Classics</dc:publisher>
        <dc:subject>Parts Edition 3 of 12 by Delphi Classics</dc:subject>
        <dc:subject>Fiction</dc:subject>
        <dc:description>www.delphiclassics.com</dc:description>`,
    });
    writeFileSync(join(root, "S/pickwick.epub"), epub);
    await app.library.open(root);
    expect(app.books.get(idOf("S/pickwick.epub"))).toMatchObject({
      publisher: "Delphi Classics",
      series: "Parts Edition",
      seriesIndex: 3,
      tags: ["Fiction"],
      description: null,
    });
  });

  test("the maintenance action fixes unconfirmed books added before the rule, and leaves confirmed ones alone", async () => {
    writeFileSync(join(root, "S/Old -- Author.epub"), "old");
    writeFileSync(join(root, "S/Confirmed -- Author.epub"), "confirmed");
    await app.library.open(root);
    const old = idOf("S/Old -- Author.epub");
    const confirmed = idOf("S/Confirmed -- Author.epub");
    await app.bookService.update(confirmed, { rating: 4 }); // a manual edit confirms
    // Metadata as imported before the rule existed.
    for (const id of [old, confirmed]) app.books.updateMetadata(id, { ...pickMetadata(app.books.get(id)!), ...delphi() }, null);

    const server = Bun.serve({ port: 0, routes: apiRoutes(app) });
    try {
      const res = await fetch(`${server.url}api/maintenance/rules`, { method: "POST" });
      expect(await res.json()).toEqual({ changed: 1 });
    } finally {
      server.stop(true);
    }
    expect(app.books.get(old)).toMatchObject({ series: "Parts Edition", seriesIndex: 3, tags: ["Fiction"], description: null });
    expect(app.books.get(confirmed)).toMatchObject({ series: null, description: "www.delphiclassics.com" });
    // Nothing left to change the second time.
    expect(await app.maintenance.applyMetadataRules()).toEqual({ changed: 0 });
  });
});
