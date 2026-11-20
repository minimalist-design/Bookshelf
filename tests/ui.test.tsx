// Render smoke tests: server-render the real pages with a pre-filled query cache to catch
// runtime render errors (wrong component APIs, bad hooks) without a browser.
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { MetadataUsageDto, BookDetailDto, LibraryFacets, LibraryPage, LibraryStatus, LookupQueueStatus, ReviewItemDto, SettingsDto, ShelfDto } from "../src/shared/types.ts";
import { App } from "../src/web/App.tsx";
import { replaceAuthor } from "../src/web/components/AuthorsInput.tsx";
import { returnUrl } from "../src/web/components/library/returnTo.ts";
import { PAGE_SIZE } from "../src/web/components/library/useLibraryParams.ts";
import { EpubReader } from "../src/web/components/reader/EpubReader.tsx";
import { PageReader } from "../src/web/components/reader/PageReader.tsx";
import { PdfReader } from "../src/web/components/reader/PdfReader.tsx";
import { BookPage } from "../src/web/pages/BookDetail.tsx";
import { isPlainClick, matchSummary, parseOpen, toggleOpen } from "../src/web/pages/ReviewQueue.tsx";
import { paperKind } from "../src/shared/workType.ts";

const book: BookDetailDto = {
  id: 1,
  title: "Dune",
  subtitle: "Deluxe",
  authors: ["Frank Herbert"],
  year: 1965,
  series: "Dune",
  seriesIndex: 1,
  isbn13: "9780441172719",
  doi: null,
  rating: 4,
  tags: ["SciFi"],
  hasCover: true,
  metadataSource: "embedded",
  confirmedSource: null,
  createdAt: "2026-01-01T00:00:00Z",
  files: [
    { hash: "a", relPath: "Fiction/x.epub", filename: "x.epub", shelf: "Fiction", format: "epub", size: 1234, mtimeMs: 0 },
    { hash: "b", relPath: "Fiction/x.pdf", filename: "x.pdf", shelf: "Fiction", format: "pdf", size: 5_000_000, mtimeMs: 0 },
  ],
  shelves: ["Fiction"],
  progress: 0.42,
  publisher: "Ace",
  edition: "2",
  publishedDate: "1965-08-01",
  language: "en",
  pages: 412,
  description: "Spice.\n\nSand.",
  notes: "Reread",
  olEditionKey: null,
  olWorkKey: null,
  confirmedAt: null,
  readingPosition: null,
  updatedAt: "2026-01-01T00:00:00Z",
};

const settings: SettingsDto = {
  libraryRoot: "/lib",
  libraryRootFromConfig: false,
  contactEmail: null,
  dataDir: "/data",
  tools: { sevenZip: true, unrar: false, djvused: true, ddjvu: true, pdftoppm: true },
  isbndb: { configured: true, dailyLimit: 5000, perSecond: 1, bulkSize: 100 },
};
const status: LibraryStatus = { state: "ready", root: "/lib", scan: null, fileCount: 2, bookCount: 1, watching: true, message: null };
const shelves: ShelfDto[] = [
  { name: null, bookCount: 0 },
  { name: "Fiction", bookCount: 1 },
];
const facets: LibraryFacets = {
  tags: [{ name: "SciFi", count: 1 }],
  series: [{ name: "Dune", count: 1 }],
  authors: [{ name: "Frank Herbert", count: 1 }],
  formats: [{ name: "epub", count: 1 }],
  languages: [{ name: "en", count: 1 }],
  publishers: [{ name: "Ace", count: 1 }],
};

const lookupStatus: LookupQueueStatus = {
  running: true, pending: 3, done: 2, failed: 0, noMatch: 1, reviewCount: 1,
  pausedUntil: "2026-01-01T12:30:00Z", pausedBy: "Open Library", waitingForLibrary: false, etaSeconds: 150, currentBookId: null,
};
const usage: MetadataUsageDto = {
  now: 0,
  identified: false,
  services: [
    { host: "openlibrary.org", name: "Open Library", calls: 96, lastHour: 412, perSecond: 1, hourLimit: 3600, coolingDownUntil: null, dailyLimit: null, today: 0, reportedLeft: null, quotaResetsAt: null },
    { host: "api2.isbndb.com", name: "ISBNdb", calls: 140, lastHour: 140, perSecond: 1, hourLimit: 3600, coolingDownUntil: null, dailyLimit: 5000, today: 1200, reportedLeft: 3700, quotaResetsAt: "2026-11-21T00:00:00.000Z" },
    { host: "doi.org", name: "doi.org", calls: 1, lastHour: 3, perSecond: null, hourLimit: null, coolingDownUntil: null, dailyLimit: null, today: 0, reportedLeft: null, quotaResetsAt: null },
  ],
};
const review: ReviewItemDto[] = [
  {
    book,
    createdAt: "2026-01-01T00:00:00Z",
    result: {
      bookId: 1,
      notes: "Signed copy",
      errors: [],
      candidates: [
        {
          source: "openlibrary",
          match: "isbn",
          id: "OL1M",
          url: "https://openlibrary.org/books/OL1M",
          label: "Open Library · Ace · 2020",
          coverUrl: "https://covers.openlibrary.org/b/id/1-L.jpg",
          olEditionKey: "OL1M",
          olWorkKey: "OL1W",
          metadata: { title: "Dune", subtitle: null, authors: ["Frank Herbert"], isbn13: "9780441172719", doi: null, publisher: "Ace Books", edition: null, publishedDate: "2020", language: "en", pages: 896, description: "Arrakis.", series: null, seriesIndex: null, tags: ["Fiction"] },
          diff: [
            { field: "title", current: "Dune", candidate: "Dune", status: "same" },
            { field: "authors", current: ["Frank Herbert"], candidate: ["Frank Herbert"], status: "same" },
            { field: "publisher", current: "Ace", candidate: "Ace Books", status: "conflict" },
            { field: "pages", current: null, candidate: 896, status: "fill" },
            { field: "doi", current: null, candidate: null, status: "missing" },
          ],
        },
        {
          source: "doi",
          match: "search",
          id: "10.1/x",
          url: "https://doi.org/10.1/x",
          label: "Crossref · book",
          coverUrl: null,
          olEditionKey: null,
          olWorkKey: null,
          metadata: { title: "Dune (other)", subtitle: null, authors: [], isbn13: null, doi: "10.1/x", publisher: null, edition: null, publishedDate: null, language: null, pages: null, description: null, series: null, seriesIndex: null, tags: [] },
          diff: [],
        },
      ],
    },
  },
];

const renderHtml = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");

function render(url: string, libraryKey: unknown, page: LibraryPage, queue: ReviewItemDto[] = review) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["settings"], settings);
  qc.setQueryData(["libraryStatus"], status);
  qc.setQueryData(["shelves"], shelves);
  qc.setQueryData(["facets"], facets);
  qc.setQueryData(["book", 1], book);
  qc.setQueryData(["library", libraryKey], page);
  qc.setQueryData(["lookupStatus"], lookupStatus);
  // The session start is only known after mount; server rendering reads the usage under `null`.
  qc.setQueryData(["metadataUsage", null], usage);
  qc.setQueryData(["reviewQueue"], queue);
  qc.setQueryData(["maintenance", "stats"], {
    booksOnDisk: 10, filesOnDisk: 12, metadataRows: 11, confirmed: 4, missing: 1, missingUnconfirmed: 0, reviewQueue: 1,
    hashCacheEntries: 12, httpCacheEntries: 30, isbndbRecords: 250, isbndbCovers: 240, isbndbCoverBytes: 12_000_000, coverFiles: 20, coverBytes: 3_500_000, orphanCoverFiles: 0, databaseBytes: 2_000_000,
  });
  qc.setQueryData(["cleanup", "groups", "authors"], {
    field: "authors",
    groups: [
      {
        main: "Jane Austen",
        variants: [
          { name: "Jane Austen", books: 3, match: "main", preselected: true },
          { name: "JANE AUSTEN", books: 2, match: "case", preselected: true },
          { name: "Jane Austin", books: 1, match: "typo", preselected: false },
        ],
      },
    ],
    singles: [{ name: "Frank Herbert", count: 1 }],
  });
  qc.setQueryData(["cleanup", "aliases"], [{ field: "authors", variant: "AUSTEN, JANE", canonical: "Jane Austen" }]);
  qc.setQueryData(["cleanup", "swaps"], [
    {
      id: 5, title: "Fokkinga M M", authors: ["A gentle introduction to category theory T"],
      files: ["Maths/A gentle introduction to category theory T - Fokkinga M M.pdf"],
      proposed: { title: "A gentle introduction to category theory T", authors: ["M. M. Fokkinga"] }, basis: "filename",
    },
    { id: 6, title: "Jane Doe", authors: ["The Long Road"], files: ["The Long Road - Jane Doe.epub"], proposed: { title: "The Long Road", authors: ["Jane Doe"] }, basis: "swap" },
  ]);
  qc.setQueryData(["maintenance", "missing"], [
    { id: 9, title: "Gone Book", authors: ["Someone"], isbn13: "9780131103627", doi: null, confirmedSource: "openlibrary", hasCover: true, formats: ["pdf"], updatedAt: "" },
  ]);
  // React separates adjacent text nodes with <!-- --> in server output.
  return renderHtml(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="*" element={<App />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const page: LibraryPage = { items: [book], total: 1, page: 1, size: PAGE_SIZE };
const baseQuery = { shelf: undefined, q: undefined, format: undefined, tag: undefined, series: undefined, author: undefined, confirmed: undefined, missing: undefined, minRating: undefined, sort: "title", order: "asc", page: 1, size: PAGE_SIZE };

describe("UI render smoke", () => {
  test("library grid", () => {
    const html = render("/", baseQuery, page);
    expect(html).toContain("All books");
    expect(html).toContain("Dune");
    expect(html).toContain("Frank Herbert");
    expect(html).toContain("Add books");
    expect(html).toContain("Fiction");
    // Bulk lookup progress is shown on every page, with the rate-limit pause and time left.
    expect(html).toContain("Looking up metadata: 2 of 5");
    expect(html).toContain("1 without matches");
    expect(html).toContain("Open Library asked us to slow down");
    expect(html).toContain("about 3 min left");
    expect(html).toContain("Review 1");
  });

  test("library with filters from the URL", () => {
    const html = render("/?shelf=Fiction&tag=SciFi&sort=series&order=desc", { ...baseQuery, shelf: "Fiction", tag: "SciFi", sort: "series", order: "desc" }, page);
    expect(html).toContain("Tag: SciFi");
    expect(html).toContain("Dune");
  });

  test("book detail", () => {
    const html = render("/books/1", baseQuery, page);
    expect(html).toContain("Dune");
    expect(html).toContain("9780441172719");
    expect(html).toContain("From the file");
    expect(html).toContain("x.pdf");
    expect(html).toContain("Reread");
    expect(html).toContain("2nd edition");
    expect(html).toContain("Replace cover"); // opens the upload / Open Library menu
  });

  test("add books page: session stats, API usage, drop area, empty queue", () => {
    const html = render("/add", baseQuery, page);
    for (const label of ["Added", "Duplicates", "Failed", "Left"]) expect(html).toContain(label);
    expect(html).toContain("Open Library");
    expect(html).toContain("412 / 3,600 in the last hour · 3,188 left (1/s)");
    expect(html).toContain("3 in the last hour · no published limit");
    // ISBNdb's card counts the day against its quota; ISBNdb's own report wins when it is lower.
    expect(html).toContain("1,200 / 5,000 today · 3,700 left");
    expect(html).toContain("ISBNdb reports 3,700 left: calls made elsewhere with the same key count too.");
    expect(html).toContain("Set a contact email in");
    expect(html).toContain("Drag books here or click to choose files");
    expect(html).toContain("Look up metadata for new books");
    expect(html).toContain("Nothing in the queue");
    expect(html).toContain('href="/add"'); // sidebar link
  });

  test("review queue with candidate comparison", () => {
    const html = render("/review?open=1", baseQuery, page);
    expect(html).toContain("Review queue");
    expect(html).toContain("Looking up metadata: 2 of 5");
    expect(html).toContain("ISBN match");
    expect(html).toContain("Ace Books");
    expect(html).toContain("896");
    expect(html).toContain("Dune (other)"); // second candidate card
    // With results queued, a manual search waits behind "Search again".
    expect(html).toContain("Search again");
    expect(html).not.toContain('aria-label="Search query"');
    expect(html).toContain("1 book<");
    expect(html).toContain('aria-expanded="true"');
    // One checkbox takes every value; rows empty on both sides are folded away.
    expect(html).toContain('aria-label="Use every Open Library value"');
    expect(html).toContain("Show 1 empty field");
    expect(html).not.toContain('aria-label="Current DOI"');
    expect(html).toContain("Will apply 1 value from Open Library.");
    expect(html).toContain("Fill missing fields for 1 ISBN/DOI match");
    // Initially only "fill" fields are selected (pages); the cover is unchecked because the book has one.
    expect(html).toContain("Apply 1 change<");
    // Every field of the book can be corrected by hand in the "Current" column.
    expect(html).toContain('aria-label="Current Title"');
    expect(html).toContain('aria-label="Current Pages"');
    expect(html).toContain('aria-label="Current Publisher"');
    // The book's own notes are editable too, with nothing to compare against.
    expect(html).toContain('aria-label="Current Notes"');
    expect(html).toContain("Signed copy");
    // Author pills can be clicked to edit their text.
    expect(html).toContain('aria-label="Edit author Frank Herbert"');
  });

  test("review queue: a paper found by DOI opens the search form, with the match still below", () => {
    const article = {
      ...review[0]!.result.candidates[1]!,
      match: "doi" as const,
      label: "Crossref · journal article · Journal of Arrakis · 2019",
      workType: "journal-article",
      metadata: { ...review[0]!.result.candidates[1]!.metadata, title: "Spice and ecology" },
    };
    const html = render("/review?open=1", baseQuery, page, [{ ...review[0]!, result: { ...review[0]!.result, candidates: [article] } }]);
    expect(html).toContain('aria-label="Search query"');
    expect(html).toContain("The lookup found a journal article, not a book.");
    expect(html).toContain("DOI match");
    // The queued match is already on screen: nothing to go back to, nor to search again for.
    expect(html).not.toContain("Back to queued results");
    expect(html).not.toContain("Search again");
  });

  test("paperKind: DOI records that are not books, from the type or (for older queued items) the label", () => {
    const base = review[0]!.result.candidates[1]!;
    expect(paperKind({ ...base, workType: "journal-article" })).toBe("journal article");
    expect(paperKind({ ...base, workType: "proceedings-article" })).toBe("proceedings article");
    expect(paperKind({ ...base, workType: "book-chapter" })).toBe("book chapter");
    expect(paperKind({ ...base, workType: "book" })).toBeNull();
    expect(paperKind({ ...base, workType: "monograph" })).toBeNull();
    expect(paperKind({ ...base, workType: "edited-book" })).toBeNull();
    expect(paperKind({ ...base, label: "Crossref · journal article · Journal of Arrakis · 2019" })).toBe("journal article");
    expect(paperKind({ ...base, label: "DOI registry · article · arXiv · 2017" })).toBe("article");
    expect(paperKind({ ...base, label: "Crossref · book" })).toBeNull();
    // Without a type the label goes on with the journal or the year: not a type.
    expect(paperKind({ ...base, label: "Crossref · Journal of Arrakis · 2019" })).toBeNull();
    expect(paperKind({ ...base, label: "DOI registry · 2017" })).toBeNull();
    expect(paperKind(review[0]!.result.candidates[0]!)).toBeNull(); // Open Library
  });

  test("review queue: a list of closed rows, each with its match and a link to the book page", () => {
    const html = render("/review", baseQuery, page);
    expect(html).toContain("Dune");
    expect(html).toContain("ISBN match");
    expect(html).toContain('aria-expanded="false"');
    // Closed rows hold no editor.
    expect(html).not.toContain('aria-label="Current Title"');
    // "Book page" is previewed in an overlay on a plain click.
    expect(html).toContain('aria-label="Preview Dune"');
    expect(html.match(/href="\/books\/1"/g)?.length).toBe(1);
  });

  test("review queue: open rows come from the URL, several at once", () => {
    expect([...parseOpen("3,17")]).toEqual([3, 17]);
    expect([...parseOpen(null)]).toEqual([]);
    expect([...parseOpen("3,,x")]).toEqual([3]);
    expect(toggleOpen(parseOpen("3"), 17)).toBe("3,17");
    expect(toggleOpen(parseOpen("3,17"), 3)).toBe("17");
    expect(toggleOpen(parseOpen("3"), 3)).toBeNull();
  });

  test("review queue: each row says what the lookup found", () => {
    const item = review[0]!;
    const [top, second] = item.result.candidates;
    const summary = (candidates: typeof item.result.candidates) => matchSummary({ ...item, result: { ...item.result, candidates } }).text;
    expect(summary([top!])).toBe("ISBN match");
    expect(summary([second!])).toBe("Title search");
    expect(summary([{ ...second!, match: "doi", workType: "journal-article" }])).toBe("Found a journal article");
    expect(summary([])).toBe("No match");
  });

  test("book page in an overlay: no Back, a link to the full page, Read returns to the page underneath", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(["book", 1], book);
    const html = renderHtml(
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={["/review"]}>
            <BookPage id={1} onClose={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(html).toContain("Dune");
    expect(html).toContain("x.pdf");
    expect(html).toContain("Open page");
    expect(html).toContain('href="/books/1"');
    expect(html).not.toContain(">Back<");
    // The standalone page keeps its Back button.
    expect(render("/books/1", baseQuery, page)).toContain(">Back<");
  });

  test("only a plain left click previews; modified or middle clicks open the link as usual", () => {
    const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    expect(isPlainClick(click)).toBe(true);
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, shiftKey: true })).toBe(false);
    expect(isPlainClick({ ...click, altKey: true })).toBe(false);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
  });

  test("book detail offers reading and downloads", () => {
    const html = render("/books/1", baseQuery, page);
    expect(html).toContain('href="/read/1/a"'); // EPUB preferred
    expect(html).toContain(">Read (EPUB)<");
    expect(html).toContain('href="/api/books/1/files/b?download=1"');
  });

  test("readers render their frame", () => {
    const wrap = (el: React.ReactElement) => {
      const qc = new QueryClient();
      qc.setQueryData(["pages", 1, "b"], { count: 12 });
      return renderHtml(
        <MantineProvider>
          <QueryClientProvider client={qc}>{el}</QueryClientProvider>
        </MantineProvider>,
      );
    };
    const noop = () => {};
    expect(wrap(<EpubReader book={book} hash="a" onBack={noop} />)).toContain("Larger text");
    expect(wrap(<PdfReader book={book} hash="b" onBack={noop} />)).toContain("Fit width");
    const pages = wrap(<PageReader book={{ ...book, readingPosition: { hash: "b", position: "3", fraction: 0.2, updatedAt: "" } }} hash="b" onBack={noop} />);
    expect(pages).toContain("/ 12");
    expect(pages).toContain('src="/api/books/1/files/b/pages/3"'); // resumes at the saved page
  });

  test("settings", () => {
    const html = render("/settings", baseQuery, page);
    expect(html).toContain("Library root");
    expect(html).toContain("Remove library");
    // ISBNdb in use, with the limits from the config file; the key's plan is fetched after mounting.
    expect(html).toContain("In use");
    expect(html).toContain("Limits from the config file: 5,000 calls a day, 1 per second.");
    expect(html).toContain("Apply metadata rules");
    expect(html).toContain("Books on disk");
    expect(html).toContain("3.3 MB"); // cover images
    expect(html).toContain("Gone Book");
    expect(html).toContain("Forget all 1");
    // Name cleanup: one folded row per group (safe variants ticked), lone authors, remembered spellings.
    expect(html).toContain("Clean up names");
    expect(html).toContain("also “JANE AUSTEN”, “Jane Austin”");
    expect(html).toContain('aria-label="Merge 1 into Jane Austen"'); // JANE AUSTEN ticked, the typo not
    expect(html).toContain('aria-label="Open Jane Austen"');
    expect(html).not.toContain("typo?"); // details only once a row is opened
    expect(html).toContain('aria-label="Look up Jane Austen"');
    expect(html).toContain('aria-label="Look up Frank Herbert"');
    expect(html).toContain("Remembered spellings (1)");
    expect(html).toContain("Currently 0 entries and 0 unused cover files.");
    // Swapped titles and authors: the fix prefilled; only the one read from the filename ticked.
    expect(html).toContain("Swapped titles and authors");
    expect(html).toContain('value="A gentle introduction to category theory T"');
    expect(html).toContain("M. M. Fokkinga");
    expect(html).toContain("from filename");
    expect(html).toContain("swap?");
    expect(html).toContain("Fix 1 book");
    // Books are links to their pages; a name's book count opens the list of its books.
    expect(html).toContain('href="/books/5"');
    expect(html).toContain('aria-label="Show the books of Jane Austen"');
    expect(html).toContain('aria-label="Show the books of Frank Herbert"');
  });
});

describe("book page Back", () => {
  test("returns to the library view, Settings or the review queue it came from, else All books", () => {
    expect(returnUrl({ from: "/?shelf=Fiction" })).toBe("/?shelf=Fiction");
    expect(returnUrl({ from: "/settings" })).toBe("/settings");
    expect(returnUrl({ from: "/review" })).toBe("/review");
    expect(returnUrl({ from: "/review?open=1,4" })).toBe("/review?open=1,4");
    expect(returnUrl({ from: "/add" })).toBe("/");
    expect(returnUrl(null)).toBe("/");
  });
});

describe("editing an author pill", () => {
  const list = ["FRANK HERBERT", "Brian Herbert"];
  test("replaces the name in place, tidying spaces", () => {
    expect(replaceAuthor(list, "FRANK HERBERT", "  Frank   Herbert ")).toEqual(["Frank Herbert", "Brian Herbert"]);
  });
  test("emptying it removes the author", () => {
    expect(replaceAuthor(list, "FRANK HERBERT", "  ")).toEqual(["Brian Herbert"]);
  });
  test("a name that repeats another author (any case) is merged into it", () => {
    expect(replaceAuthor(list, "FRANK HERBERT", "brian herbert")).toEqual(["Brian Herbert"]);
  });
});
