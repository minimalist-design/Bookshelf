import type { Database } from "bun:sqlite";
import type { CoverStore } from "../covers/store.ts";
import type { BookRecord, BooksRepo } from "../db/repo/books.ts";
import type { EventBus } from "../events.ts";
import type { Library } from "../library/library.ts";
import { ValidationError } from "../library/paths.ts";
import { toSummary } from "../library/queries.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { diffMetadata } from "../sources/diff.ts";
import { lookupDoi, searchCrossref } from "../sources/doi.ts";
import type { HttpClient } from "../sources/http.ts";
import { openLibraryByIsbn, openLibraryEditionCovers, openLibrarySearch } from "../sources/openlibrary.ts";
import type {
  ApplyMetadataRequest,
  BookActionResult,
  BookUpdate,
  CoverOption,
  CoverSearchResult,
  LookupQueueStatus,
  LookupResult,
  LookupSource,
  MetadataCandidate,
  MetadataField,
  ReviewItemDto,
} from "../../shared/types.ts";
import { METADATA_FIELDS } from "../../shared/types.ts";
import { NotFoundError } from "../api/http.ts";
import type { BookService } from "./bookService.ts";

export interface LookupDeps {
  db: Database;
  http: HttpClient;
  library: Library;
  books: BooksRepo;
  bookService: BookService;
  covers: CoverStore;
  events: EventBus;
}

export interface LookupOptions {
  /** Restrict to one source (default: whatever fits the book). */
  source?: LookupSource;
  /** Free text, an ISBN or a DOI typed by the user instead of the book's own data. */
  q?: string;
}

const COVER_HOSTS = new Set(["covers.openlibrary.org"]);
/** Works whose editions are listed in the cover picker (one request each, throttled to 1/s). */
const MAX_EXPANDED_WORKS = 3;

/** Title for matching search results to the book: case, punctuation and subtitle ignored. */
const titleKey = (t: string) => t.toLowerCase().split(":")[0]!.replace(/[^\p{L}\p{N}]+/gu, "");

function candidateCover(c: MetadataCandidate): CoverOption {
  const m = c.metadata;
  return {
    coverUrl: c.coverUrl!,
    url: c.url,
    title: m.title ?? "",
    subtitle: m.subtitle,
    authors: m.authors,
    details: c.label.replace(/^Open Library( · )?/, ""),
    language: m.language,
    isbn13: m.isbn13,
    thisEdition: false,
  };
}

/**
 * Finds metadata candidates in Open Library (ISBN, title/author) and the DOI registries
 * (Crossref, doi.org), applies the fields the user accepts (which confirms the book),
 * and runs bulk lookups in the background, collecting results in the review queue.
 */
export class LookupService {
  private pending: number[] = [];
  private running = false;
  private stats = { done: 0, failed: 0, noMatch: 0 };

  constructor(private readonly deps: LookupDeps) {}

  private requireVisible(id: number): BookRecord {
    const book = this.deps.library.index.hasBook(id) ? this.deps.books.get(id) : null;
    if (!book) throw new NotFoundError(`Book ${id} not found`);
    return book;
  }

  // ---- single lookup ---------------------------------------------------------------

  async lookup(bookId: number, opts: LookupOptions = {}): Promise<LookupResult> {
    const book = this.requireVisible(bookId);
    const { candidates, errors } = await this.findCandidates(book, opts);
    return this.withDiffs(book, candidates, errors);
  }

  private withDiffs(book: BookRecord, candidates: MetadataCandidate[], errors: string[] = []): LookupResult {
    return { bookId: book.id, candidates: candidates.map((c) => ({ ...c, diff: diffMetadata(book, c.metadata) })), errors };
  }

  private async findCandidates(book: BookRecord, opts: LookupOptions): Promise<{ candidates: MetadataCandidate[]; errors: string[] }> {
    const { http } = this.deps;
    const out: MetadataCandidate[] = [];
    const errors: string[] = [];
    const wants = (s: LookupSource) => !opts.source || opts.source === s;
    const attempt = async (label: string, fn: () => Promise<MetadataCandidate | MetadataCandidate[] | null>) => {
      try {
        const r = await fn();
        if (Array.isArray(r)) out.push(...r);
        else if (r) out.push(r);
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const q = opts.q?.trim();
    const isbn = q ? normalizeIsbn(q) : book.isbn13;
    const doi = q ? normalizeDoi(q) : book.doi;
    if (isbn && wants("openlibrary")) await attempt("Open Library", () => openLibraryByIsbn(http, isbn));
    if (doi && wants("doi")) await attempt("DOI", () => lookupDoi(http, doi));

    // Typed identifiers are exact: no fallback search. Otherwise search when identifiers found nothing.
    const typedId = !!q && (!!normalizeIsbn(q) || !!normalizeDoi(q));
    if (out.length === 0 && !typedId) {
      const query = q ? { q } : { title: book.title, author: book.authors[0] ?? null };
      if (wants("openlibrary")) await attempt("Open Library search", () => openLibrarySearch(http, query));
      // Papers and DOI books live in Crossref; skip it for plain book searches when the user picked OL.
      if (wants("doi")) await attempt("Crossref search", () => searchCrossref(http, query));
    }
    return { candidates: out, errors };
  }

  // ---- applying ----------------------------------------------------------------------

  /** Apply the chosen fields (and optionally the cover) of a candidate; confirms the book. */
  async apply(bookId: number, req: ApplyMetadataRequest): Promise<BookActionResult> {
    this.requireVisible(bookId);
    const c = req?.candidate;
    if (!c || (c.source !== "openlibrary" && c.source !== "doi") || !c.metadata) throw new ValidationError("Invalid candidate");
    const fields = (req.fields ?? []).filter((f): f is MetadataField => (METADATA_FIELDS as readonly string[]).includes(f));

    const patch: BookUpdate = {};
    for (const f of fields) {
      const v = c.metadata[f];
      const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
      if (!empty) (patch as Record<string, unknown>)[f] = v; // accepting never clears a field
    }
    if (patch.series === undefined && patch.seriesIndex !== undefined && !this.deps.books.get(bookId)?.series) delete patch.seriesIndex;

    // Fetch the cover before touching anything, so a failed download doesn't half-apply.
    const cover = req.cover && c.coverUrl ? await this.downloadCover(c.coverUrl) : null;

    const result = await this.deps.bookService.update(bookId, patch, {
      confirm: c.source,
      ...(c.source === "openlibrary" && c.match !== "search" ? { olEditionKey: c.olEditionKey, olWorkKey: c.olWorkKey } : {}),
      ...(c.source === "openlibrary" && c.match === "search" ? { olWorkKey: c.olWorkKey } : {}),
    });
    if (cover && (await this.deps.covers.save(bookId, { data: cover, mime: "image/jpeg" }))) {
      this.deps.books.setHasCover(bookId, true, "openlibrary");
      result.book = { ...result.book, hasCover: true };
    }
    this.removeFromQueue(bookId);
    this.deps.events.libraryChanged([bookId]);
    return result;
  }

  /** Only Open Library covers are fetched; `default=false` makes a missing image a 404 instead of a blank. */
  private async downloadCover(coverUrl: string): Promise<Uint8Array | null> {
    let url: URL;
    try {
      url = new URL(coverUrl);
    } catch {
      throw new ValidationError("Cover URL not allowed");
    }
    if (url.protocol !== "https:" || !COVER_HOSTS.has(url.host)) throw new ValidationError("Cover URL not allowed");
    url.searchParams.set("default", "false");
    return this.deps.http.getBytes(url.toString());
  }

  // ---- covers ------------------------------------------------------------------------

  /**
   * Every Open Library cover that could belong to the book: its own ISBN edition first, then the
   * covers of all editions of the matching work(s) (book's language first), then other search
   * results. A typed ISBN starts from that edition; other text replaces the title/author search.
   */
  async findCovers(bookId: number, q?: string): Promise<CoverSearchResult> {
    const book = this.requireVisible(bookId);
    const { http } = this.deps;
    const errors: string[] = [];
    const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };

    const text = q?.trim();
    const isbn = text ? normalizeIsbn(text) : book.isbn13;
    const own = isbn ? await attempt("Open Library", () => openLibraryByIsbn(http, isbn)) : null;
    const works =
      !text || !isbn
        ? ((await attempt("Open Library search", () =>
            openLibrarySearch(http, text ? { q: text } : { title: book.title, author: book.authors[0] ?? null }, 10),
          )) ?? [])
        : [];

    // Expand the edition's work and the search results that are the same title (not sequels etc.).
    const target = titleKey(own?.metadata.title ?? (text ? works[0]?.metadata.title : book.title) ?? "");
    let same = works.filter((w) => titleKey(w.metadata.title ?? "") === target);
    if (!own && !same.length && works[0]) same = [works[0]];
    const expand = new Map<string, string[]>();
    if (own?.olWorkKey) expand.set(own.olWorkKey, own.metadata.authors);
    for (const w of same) if (w.olWorkKey && !expand.has(w.olWorkKey)) expand.set(w.olWorkKey, w.metadata.authors);

    const editions: CoverOption[] = [];
    for (const [workKey, authors] of [...expand].slice(0, MAX_EXPANDED_WORKS)) {
      editions.push(...((await attempt("Open Library editions", () => openLibraryEditionCovers(http, workKey, authors))) ?? []));
    }
    const lang = book.language;
    if (lang) editions.sort((a, b) => Number(b.language === lang) - Number(a.language === lang)); // stable

    const options: CoverOption[] = [];
    if (own?.coverUrl) options.push(candidateCover(own));
    options.push(...editions);
    for (const w of works) if (w.coverUrl && !(w.olWorkKey && expand.has(w.olWorkKey) && editions.length)) options.push(candidateCover(w));

    const seen = new Set<string>();
    const unique = options
      .map((o) => ({ ...o, thisEdition: !!book.isbn13 && o.isbn13 === book.isbn13 }))
      .filter((o) => !seen.has(o.coverUrl) && seen.add(o.coverUrl));
    // The book's own edition(s) first.
    unique.sort((a, b) => Number(b.thisEdition) - Number(a.thisEdition));
    return { bookId, options: unique, errors };
  }

  /** Download a cover picked from a lookup result and make it the book's cover (like an upload). */
  async setCoverFromUrl(bookId: number, coverUrl: unknown): Promise<void> {
    this.requireVisible(bookId);
    if (typeof coverUrl !== "string" || !coverUrl) throw new ValidationError("Missing cover URL");
    const data = await this.downloadCover(coverUrl);
    if (!data) throw new ValidationError("Open Library has no image for this cover");
    if (!(await this.deps.covers.save(bookId, { data, mime: "image/jpeg" }))) throw new ValidationError("The image could not be read");
    this.deps.books.setHasCover(bookId, true, "openlibrary");
    this.deps.books.confirm(bookId, "manual");
    this.deps.events.libraryChanged([bookId]);
  }

  // ---- review queue ------------------------------------------------------------------

  reviewQueue(): ReviewItemDto[] {
    const rows = this.deps.db.query("SELECT book_id, payload, created_at FROM review_queue ORDER BY created_at, book_id").all() as {
      book_id: number;
      payload: string;
      created_at: string;
    }[];
    const { library, books } = this.deps;
    const records = books.getMany(rows.map((r) => r.book_id));
    return rows
      .filter((r) => library.index.hasBook(r.book_id) && records.has(r.book_id))
      .map((r) => {
        const book = records.get(r.book_id)!;
        return {
          book: toSummary(book, library.index.filesOfBook(book.id)),
          result: this.withDiffs(book, JSON.parse(r.payload) as MetadataCandidate[]),
          createdAt: r.created_at,
        };
      });
  }

  reviewCount(): number {
    const ids = (this.deps.db.query("SELECT book_id FROM review_queue").all() as { book_id: number }[]).map((r) => r.book_id);
    return ids.filter((id) => this.deps.library.index.hasBook(id)).length;
  }

  removeFromQueue(bookId: number): void {
    const res = this.deps.db.query("DELETE FROM review_queue WHERE book_id = ?").run(bookId);
    if (res.changes) this.emitStatus();
  }

  /**
   * Accept, for every queued book whose best candidate matched by ISBN/DOI, only the fields
   * the book is missing (plus the cover when it has none). Search matches are left for review.
   */
  async acceptAllFills(): Promise<{ applied: number; skipped: number; errors: string[] }> {
    let applied = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const item of this.reviewQueue()) {
      const best = item.result.candidates[0];
      if (!best || best.match === "search") {
        skipped++;
        continue;
      }
      try {
        await this.apply(item.book.id, {
          candidate: best,
          fields: best.diff.filter((d) => d.status === "fill").map((d) => d.field),
          cover: !item.book.hasCover && !!best.coverUrl,
        });
        applied++;
      } catch (err) {
        errors.push(`${item.book.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { applied, skipped, errors };
  }

  // ---- bulk lookups ------------------------------------------------------------------

  /** Queue books for background lookup; results land in the review queue. */
  enqueue(ids: number[]): LookupQueueStatus {
    if (!this.running && this.pending.length === 0) this.stats = { done: 0, failed: 0, noMatch: 0 };
    const known = new Set(this.pending);
    for (const id of ids) if (!known.has(id) && this.deps.library.index.hasBook(id)) this.pending.push(id), known.add(id);
    void this.drain();
    return this.status();
  }

  status(): LookupQueueStatus {
    return { running: this.running, pending: this.pending.length, ...this.stats, reviewCount: this.reviewCount() };
  }

  /** Waits for the background worker to finish (tests). */
  async idle(): Promise<void> {
    while (this.running || this.pending.length) await Bun.sleep(20);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emitStatus();
    try {
      while (this.pending.length) {
        const id = this.pending.shift()!;
        const book = this.deps.library.index.hasBook(id) ? this.deps.books.get(id) : null;
        if (!book) continue;
        try {
          const { candidates, errors } = await this.findCandidates(book, {});
          if (candidates.length) {
            this.deps.db
              .query(
                `INSERT INTO review_queue (book_id, payload) VALUES (?, ?)
                 ON CONFLICT(book_id) DO UPDATE SET payload = excluded.payload, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
              )
              .run(id, JSON.stringify(candidates));
          } else if (errors.length) this.stats.failed++;
          else this.stats.noMatch++;
        } catch {
          this.stats.failed++;
        }
        this.stats.done++;
        this.emitStatus();
      }
    } finally {
      this.running = false;
      this.emitStatus();
    }
  }

  private emitStatus(): void {
    this.deps.events.emit({ type: "lookup.status", status: this.status() });
  }
}
