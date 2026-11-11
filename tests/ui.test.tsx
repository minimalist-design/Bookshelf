// Render smoke tests: server-render the real pages with a pre-filled query cache to catch
// runtime render errors (wrong component APIs, bad hooks) without a browser.
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { BookDetailDto, LibraryFacets, LibraryPage, LibraryStatus, LookupQueueStatus, ReviewItemDto, SettingsDto, ShelfDto } from "../src/shared/types.ts";
import { App } from "../src/web/App.tsx";
import { PAGE_SIZE } from "../src/web/components/library/useLibraryParams.ts";
import { EpubReader } from "../src/web/components/reader/EpubReader.tsx";
import { PageReader } from "../src/web/components/reader/PageReader.tsx";
import { PdfReader } from "../src/web/components/reader/PdfReader.tsx";

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
  libraryRootFromEnv: false,
  contactEmail: null,
  dataDir: "/data",
  tools: { sevenZip: true, unrar: false, djvused: true, ddjvu: true, pdftoppm: true },
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

const lookupStatus: LookupQueueStatus = { running: true, pending: 3, done: 2, failed: 0, noMatch: 1, reviewCount: 1 };
const review: ReviewItemDto[] = [
  {
    book,
    createdAt: "2026-01-01T00:00:00Z",
    result: {
      bookId: 1,
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
          metadata: { title: "Dune", subtitle: null, authors: ["Frank Herbert"], isbn13: "9780441172719", doi: null, publisher: "Ace Books", publishedDate: "2020", language: "en", pages: 896, description: "Arrakis.", series: null, seriesIndex: null, tags: ["Fiction"] },
          diff: [
            { field: "title", current: "Dune", candidate: "Dune", status: "same" },
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
          metadata: { title: "Dune (other)", subtitle: null, authors: [], isbn13: null, doi: "10.1/x", publisher: null, publishedDate: null, language: null, pages: null, description: null, series: null, seriesIndex: null, tags: [] },
          diff: [],
        },
      ],
    },
  },
];

const renderHtml = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");

function render(url: string, libraryKey: unknown, page: LibraryPage) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["settings"], settings);
  qc.setQueryData(["libraryStatus"], status);
  qc.setQueryData(["shelves"], shelves);
  qc.setQueryData(["facets"], facets);
  qc.setQueryData(["book", 1], book);
  qc.setQueryData(["library", libraryKey], page);
  qc.setQueryData(["lookupStatus"], lookupStatus);
  qc.setQueryData(["reviewQueue"], review);
  qc.setQueryData(["maintenance", "stats"], {
    booksOnDisk: 10, filesOnDisk: 12, metadataRows: 11, confirmed: 4, missing: 1, missingUnconfirmed: 0, reviewQueue: 1,
    hashCacheEntries: 12, httpCacheEntries: 30, coverFiles: 20, coverBytes: 3_500_000, orphanCoverFiles: 0, databaseBytes: 2_000_000,
  });
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
  });

  test("review queue with candidate comparison", () => {
    const html = render("/review", baseQuery, page);
    expect(html).toContain("Review queue");
    expect(html).toContain("Looking up books… 2 of 5");
    expect(html).toContain("ISBN match");
    expect(html).toContain("Ace Books");
    expect(html).toContain("896");
    expect(html).toContain("Dune (other)"); // second candidate card
    expect(html).toContain("Fill missing fields for 1 ISBN/DOI match");
    // Initially only "fill" fields are selected (pages); the cover is unchecked because the book has one.
    expect(html).toContain("Apply 1 change<");
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
    expect(html).toContain("Books on disk");
    expect(html).toContain("3.3 MB"); // cover images
    expect(html).toContain("Gone Book");
    expect(html).toContain("Forget all 1");
    expect(html).toContain("Currently 0 entries and 0 unused cover files.");
  });
});
