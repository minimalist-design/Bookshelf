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
import { openLibraryByIsbn, openLibrarySearch } from "../sources/openlibrary.ts";
import type {
  ApplyMetadataRequest,
  BookActionResult,
  BookUpdate,
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
    let cover: Uint8Array | null = null;
    if (req.cover && c.coverUrl) {
      const url = new URL(c.coverUrl);
      if (url.protocol !== "https:" || !COVER_HOSTS.has(url.host)) throw new ValidationError("Cover URL not allowed");
      url.searchParams.set("default", "false");
      cover = await this.deps.http.getBytes(url.toString());
    }

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
