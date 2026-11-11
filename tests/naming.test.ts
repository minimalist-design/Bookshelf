import { describe, expect, test } from "bun:test";
import { authorsForFilename, splitAuthors, toDisplayName, toSortName } from "../src/server/naming/authors.ts";
import { buildLibraryFilename, MAX_FILENAME_BYTES, withCollisionSuffix } from "../src/server/naming/buildFilename.ts";
import { doiCandidatesFromFilename, doiFromFilename, doiToFilename, normalizeDoi } from "../src/server/naming/doi.ts";
import { detectFormat } from "../src/server/naming/formats.ts";
import { isValidIsbn13, normalizeIsbn } from "../src/server/naming/isbn.ts";
import { parseFilename } from "../src/server/naming/parseFilename.ts";
import { byteLength, sanitizeComponent } from "../src/server/naming/sanitize.ts";

describe("detectFormat", () => {
  test.each([
    ["Book.epub", "epub", ".epub", "Book"],
    ["Book.PDF", "pdf", ".PDF", "Book"],
    ["Book.fb2.zip", "fb2", ".fb2.zip", "Book"],
    ["Book.fbz", "fb2", ".fbz", "Book"],
    ["Comic.cbz", "cbz", ".cbz", "Comic"],
    ["Comic.cbr", "cbr", ".cbr", "Comic"],
    ["Scan.djv", "djvu", ".djv", "Scan"],
    ["a.b.c.djvu", "djvu", ".djvu", "a.b.c"],
  ])("%s", (name, format, ext, stem) => {
    expect(detectFormat(name)).toEqual({ format: format as never, ext, stem });
  });

  test("unsupported", () => {
    expect(detectFormat("notes.txt")).toBeNull();
    expect(detectFormat("archive.zip")).toBeNull();
    expect(detectFormat(".epub")).toBeNull();
  });
});

describe("ISBN", () => {
  test("checksum", () => {
    expect(isValidIsbn13("9780131103627")).toBe(true);
    expect(isValidIsbn13("9780131103628")).toBe(false);
  });
  test("normalize", () => {
    expect(normalizeIsbn("978-0-13-110362-7")).toBe("9780131103627");
    expect(normalizeIsbn("urn:isbn:9780131103627")).toBe("9780131103627");
    expect(normalizeIsbn("ISBN-13: 978 0 13 110362 7")).toBe("9780131103627");
    expect(normalizeIsbn("0131103628")).toBe("9780131103627"); // ISBN-10 → 13
    expect(normalizeIsbn("0-8044-2957-X")).toBe("9780804429573");
    expect(normalizeIsbn("0131103629")).toBeNull(); // bad ISBN-10 checksum
    expect(normalizeIsbn("12345")).toBeNull();
    expect(normalizeIsbn(null)).toBeNull();
  });
});

describe("DOI", () => {
  test("normalize", () => {
    expect(normalizeDoi("https://doi.org/10.1000/xyz123")).toBe("10.1000/xyz123");
    expect(normalizeDoi("doi:10.1000/xyz123.")).toBe("10.1000/xyz123");
    expect(normalizeDoi("http://dx.doi.org/10.1093/ajae/aaq063")).toBe("10.1093/ajae/aaq063");
    expect(normalizeDoi("10.1000")).toBeNull();
    expect(normalizeDoi("not a doi")).toBeNull();
  });
  test("filename round trip", () => {
    expect(doiToFilename("10.1000/xyz123")).toBe("10.1000_xyz123");
    expect(doiFromFilename("10.1000_xyz123")).toBe("10.1000/xyz123");
    // Only the first underscore is reversed.
    expect(doiFromFilename("10.1007_978-3-540_x")).toBe("10.1007/978-3-540_x");
    expect(doiFromFilename("10.1000/already")).toBe("10.1000/already");
    expect(doiFromFilename("11.1000_x")).toBeNull();
  });
  test("candidates for ambiguous suffixes", () => {
    expect(doiCandidatesFromFilename("10.1093_ajae_aaq063")).toEqual(["10.1093/ajae_aaq063", "10.1093/ajae/aaq063"]);
    expect(doiCandidatesFromFilename("10.1000_xyz")).toEqual(["10.1000/xyz"]);
  });
});

describe("authors", () => {
  test.each([
    ["Brian W. Kernighan, Dennis M. Ritchie", ["Brian W. Kernighan", "Dennis M. Ritchie"]],
    ["Kernighan, Brian W.; Ritchie, Dennis M.", ["Brian W. Kernighan", "Dennis M. Ritchie"]],
    ["Tolkien, J. R. R.", ["J. R. R. Tolkien"]],
    ["Le Guin, Ursula K.", ["Ursula K. Le Guin"]],
    ["Smith, John", ["John Smith"]],
    ["Gamma & Helm & Johnson & Vlissides", ["Gamma", "Helm", "Johnson", "Vlissides"]],
    ["Erich Gamma and Richard Helm", ["Erich Gamma", "Richard Helm"]],
    ["Abelson, Sussman, Sussman", ["Abelson", "Sussman"]], // de-duplicated
    ["Donald Knuth et al.", ["Donald Knuth"]],
    ["  Jane   Austen ", ["Jane Austen"]],
    ["", []],
  ])("%p", (input, expected) => {
    expect(splitAuthors(input)).toEqual(expected);
  });

  test("display and sort names", () => {
    expect(toDisplayName("Austen, Jane")).toBe("Jane Austen");
    expect(toDisplayName("Plato")).toBe("Plato");
    expect(toSortName("Jane Austen")).toBe("Austen, Jane");
    expect(toSortName("Ludwig van Beethoven")).toBe("van Beethoven, Ludwig");
    expect(toSortName("Martin Luther King Jr.")).toBe("King, Martin Luther, Jr.");
    expect(toSortName("Plato")).toBe("Plato");
  });

  test("filename author part", () => {
    expect(authorsForFilename([])).toBe("Unknown");
    expect(authorsForFilename(["A"])).toBe("A");
    expect(authorsForFilename(["A", "B"])).toBe("A & B");
    expect(authorsForFilename(["A", "B", "C"])).toBe("A et al.");
  });
});

describe("parseFilename: import pattern", () => {
  test("title and author", () => {
    const p = parseFilename("The C Programming Language -- Brian W. Kernighan, Dennis M. Ritchie.pdf");
    expect(p.pattern).toBe("import");
    expect(p.title).toBe("The C Programming Language");
    expect(p.authors).toEqual(["Brian W. Kernighan", "Dennis M. Ritchie"]);
    expect(p.isbn13).toBeNull();
    expect(p.doi).toBeNull();
  });

  test("isbn13 and doi tokens anywhere", () => {
    const p = parseFilename("Title -- Author -- isbn13 9780131103627 -- doi 10.1000_xyz123.epub");
    expect(p.title).toBe("Title");
    expect(p.authors).toEqual(["Author"]);
    expect(p.isbn13).toBe("9780131103627");
    expect(p.isbn13Valid).toBe(true);
    expect(p.doi).toBe("10.1000/xyz123");
    expect(p.doiToken).toBe("10.1000_xyz123");
  });

  test("Anna's Archive style with extra segments", () => {
    const p = parseFilename(
      "Structure and Interpretation of Computer Programs -- Abelson, Harold; Sussman, Gerald Jay -- 2, 1996 -- MIT Press -- isbn13 9780262510875 -- 0c9a4b1d2e3f4a5b6c7d8e9f0a1b2c3d -- Anna’s Archive.pdf",
    );
    expect(p.title).toBe("Structure and Interpretation of Computer Programs");
    expect(p.authors).toEqual(["Harold Abelson", "Gerald Jay Sussman"]);
    expect(p.isbn13).toBe("9780262510875");
  });

  test("token inside the author segment", () => {
    const p = parseFilename("Title -- Author Name isbn13 978-0-13-110362-7.pdf");
    expect(p.authors).toEqual(["Author Name"]);
    expect(p.isbn13).toBe("9780131103627");
  });

  test("ID-only second segment means no author", () => {
    const p = parseFilename("Some Paper -- doi 10.1145_3290605.pdf");
    expect(p.title).toBe("Some Paper");
    expect(p.authors).toEqual([]);
    expect(p.doi).toBe("10.1145/3290605");
  });

  test("invalid ISBN checksum is kept but flagged", () => {
    const p = parseFilename("T -- A -- isbn13 9780131103628.epub");
    expect(p.isbn13).toBe("9780131103628");
    expect(p.isbn13Valid).toBe(false);
  });

  test("title containing a single hyphen", () => {
    const p = parseFilename("Foo - The Sequel -- Jane Doe.epub");
    expect(p.title).toBe("Foo - The Sequel");
    expect(p.authors).toEqual(["Jane Doe"]);
  });
});

describe("parseFilename: library pattern", () => {
  test("with ISBN", () => {
    const p = parseFilename("Brian W. Kernighan & Dennis M. Ritchie - The C Programming Language [9780131103627].pdf");
    expect(p.pattern).toBe("library");
    expect(p.authors).toEqual(["Brian W. Kernighan", "Dennis M. Ritchie"]);
    expect(p.title).toBe("The C Programming Language");
    expect(p.isbn13).toBe("9780131103627");
  });

  test("with DOI and collision counter", () => {
    const p = parseFilename("Jane Doe et al. - A Study - Part 2 [10.1000_xyz] (2).pdf");
    expect(p.authors).toEqual(["Jane Doe"]);
    expect(p.title).toBe("A Study - Part 2");
    expect(p.doi).toBe("10.1000/xyz");
  });

  test("without ID; brackets that are not IDs stay in the title", () => {
    expect(parseFilename("Jane Austen - Emma.epub")).toMatchObject({ title: "Emma", authors: ["Jane Austen"] });
    expect(parseFilename("Jane Austen - Emma [Illustrated].epub").title).toBe("Emma [Illustrated]");
    expect(parseFilename("Unknown - Mystery.epub").authors).toEqual([]);
  });

  test("plain filenames become the title", () => {
    expect(parseFilename("Moby Dick.epub")).toMatchObject({ pattern: "plain", title: "Moby Dick", authors: [] });
  });
});

describe("sanitize + build", () => {
  test("sanitizeComponent", () => {
    expect(sanitizeComponent("Title: Subtitle")).toBe("Title - Subtitle");
    expect(sanitizeComponent("AC/DC \\ Live")).toBe("AC_DC _ Live");
    expect(sanitizeComponent('Who Moved My "Cheese"?')).toBe("Who Moved My 'Cheese'");
    expect(sanitizeComponent("...hidden")).toBe("hidden");
    expect(sanitizeComponent("Ends with dots...")).toBe("Ends with dots");
    expect(sanitizeComponent("A -- B")).toBe("A - B");
    expect(sanitizeComponent("Vol [1]")).toBe("Vol (1)");
    expect(sanitizeComponent("tab\there")).toBe("tab here");
  });

  test("buildLibraryFilename", () => {
    expect(
      buildLibraryFilename(
        { title: "The C Programming Language", authors: ["Brian W. Kernighan", "Dennis M. Ritchie"], isbn13: "9780131103627" },
        ".pdf",
      ),
    ).toBe("Brian W. Kernighan & Dennis M. Ritchie - The C Programming Language [9780131103627].pdf");
    expect(buildLibraryFilename({ title: "Paper: Results", authors: ["A", "B", "C"], doi: "10.1000/x/y" }, ".pdf")).toBe(
      "A et al. - Paper - Results [10.1000_x_y].pdf",
    );
    expect(buildLibraryFilename({ title: "Emma", authors: [] }, ".epub")).toBe("Unknown - Emma.epub");
    // ISBN takes precedence over DOI
    expect(buildLibraryFilename({ title: "T", authors: ["A"], isbn13: "9780131103627", doi: "10.1/x" }, ".epub")).toBe(
      "A - T [9780131103627].epub",
    );
  });

  test("build → parse round trip", () => {
    const meta = { title: "Structure and Interpretation of Computer Programs", authors: ["Harold Abelson", "Gerald Jay Sussman"], isbn13: "9780262510875" };
    const p = parseFilename(buildLibraryFilename(meta, ".pdf"));
    expect(p).toMatchObject({ pattern: "library", title: meta.title, authors: meta.authors, isbn13: meta.isbn13 });
  });

  test("long names are truncated to fit NAME_MAX with room for a collision suffix", () => {
    const name = buildLibraryFilename({ title: "Ü".repeat(300), authors: ["Author"], isbn13: "9780131103627" }, ".epub");
    expect(byteLength(name)).toBeLessThanOrEqual(MAX_FILENAME_BYTES - 6);
    expect(name.endsWith(" [9780131103627].epub")).toBe(true);
    expect(name.startsWith("Author - ÜÜ")).toBe(true);
    expect(byteLength(withCollisionSuffix(name, ".epub", 99))).toBeLessThanOrEqual(MAX_FILENAME_BYTES);
  });

  test("author part never contains the library separator", () => {
    expect(buildLibraryFilename({ title: "T", authors: ["Jean - Paul"] }, ".epub")).toBe("Jean Paul - T.epub");
  });

  test("collision suffix", () => {
    expect(withCollisionSuffix("A - T [1].epub", ".epub", 2)).toBe("A - T [1] (2).epub");
    expect(withCollisionSuffix("A - T.epub", ".epub", 1)).toBe("A - T.epub");
  });
});
