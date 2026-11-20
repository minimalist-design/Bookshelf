import type { Database } from "bun:sqlite";
import type { CoverStore } from "../covers/store.ts";
import type { BookRecord, BooksRepo } from "../db/repo/books.ts";
import type { EventBus } from "../events.ts";
import type { Library } from "../library/library.ts";
import { ValidationError } from "../library/paths.ts";
import { toSummary } from "../library/queries.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { applyRules } from "../metadata/rules.ts";
import { diffMetadata } from "../sources/diff.ts";
import { lookupDoi, searchCrossref } from "../sources/doi.ts";
import type { IsbndbConfig } from "../config.ts";
import { QuotaExceededError, RateLimitedError, serviceName, type HttpClient } from "../sources/http.ts";
import type { IsbndbRecordsRepo } from "../db/repo/isbndbRecords.ts";
import { isbndbByIsbn, isbndbKeptSearch, isbndbKeyInfo, isbndbSearch, keptByIsbn } from "../sources/isbndb.ts";
import type { IsbndbCoverDownloader } from "./isbndbCovers.ts";
import { openLibraryByIsbn, openLibraryEditionCovers, openLibrarySearch } from "../sources/openlibrary.ts";
import type {
  ApplyMetadataRequest,
  BookActionResult,
  BookUpdate,
  CoverOption,
  CoverSearchResult,
  IsbndbKeyDto,
  LookupJobDto,
  LookupJobState as JobState,
  LookupQueueStatus,
  LookupResult,
  LookupSource,
  MetadataCandidate,
  MetadataField,
  ReviewItemDto,
} from "../../shared/types.ts";
import { METADATA_FIELDS } from "../../shared/types.ts";

/** Fields that can be typed in while reviewing a lookup: the metadata, plus the book's own notes. */
const EDITABLE_FIELDS = [...METADATA_FIELDS, "notes"] as const;
import { NotFoundError } from "../api/http.ts";
import type { AliasesRepo } from "../db/repo/aliases.ts";
import type { BookService } from "./bookService.ts";

export interface LookupDeps {
  db: Database;
  http: HttpClient;
  library: Library;
  books: BooksRepo;
  /** Candidates use the remembered main spelling of names, like imports do. */
  aliases: AliasesRepo;
  bookService: BookService;
  covers: CoverStore;
  events: EventBus;
  /** ISBNdb: its API is asked only when picked by name (its calls are paid); its kept records answer automatic lookups. */
  isbndb: IsbndbConfig;
  /** Every record ISBNdb has sent, kept for good; read before asking ISBNdb. */
  isbndbRecords: IsbndbRecordsRepo;
  /** Their cover images, downloaded in the background. */
  isbndbCovers: IsbndbCoverDownloader;
}

export interface LookupOptions {
  /** Restrict to one source (default: whatever fits the book). */
  source?: LookupSource;
  /** Free text, an ISBN or a DOI typed by the user instead of the book's own data. */
  q?: string;
}

const COVER_HOSTS = new Set(["covers.openlibrary.org", "images.isbndb.com"]);
/** Books whose lookup time feeds the time-left estimate. */
const ETA_WINDOW = 20;
/** Finished jobs of earlier runs are kept this long (clients read their outcome through /api/lookup/jobs). */
const OLD_JOB_RETENTION = "-1 day";
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
 * Finds metadata candidates in the kept ISBNdb records (its API only when ISBNdb is picked by
 * name), else Open Library (ISBN, title/author), and the DOI registries (Crossref, doi.org);
 * applies the fields the user accepts (which confirms the book), and runs bulk lookups in the
 * background, collecting results in the review queue. Bulk lookups never call ISBNdb.
 */
export class LookupService {
  /** The background worker is active (it may be paused or waiting for the library). */
  private working = false;
  private stopped = false;
  private pause: { until: number; by: string } | null = null;
  private waitingForLibrary = false;
  private currentBookId: number | null = null;
  private wake: (() => void) | null = null;
  /** Milliseconds per looked-up book in this run (most recent last). */
  private durations: number[] = [];

  constructor(private readonly deps: LookupDeps) {
    // Resume a run interrupted by a restart (the worker waits for the library scan).
    if (this.countPending() > 0) void this.drain();
  }

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
    const canonical = candidates.map((c) => ({ ...c, metadata: this.deps.aliases.apply(applyRules(c.metadata)) }));
    return { bookId: book.id, notes: book.notes, candidates: canonical.map((c) => ({ ...c, diff: diffMetadata(book, c.metadata) })), errors };
  }

  /** With `rethrowRateLimits`, a rate-limited source aborts the lookup (to be retried later) instead of being reported. */
  private async findCandidates(
    book: BookRecord,
    opts: LookupOptions,
    rethrowRateLimits = false,
  ): Promise<{ candidates: MetadataCandidate[]; errors: string[] }> {
    const { http } = this.deps;
    const key = this.deps.isbndb.apiKey;
    const out: MetadataCandidate[] = [];
    const errors: string[] = [];
    const wants = (s: LookupSource) => !opts.source || opts.source === s;
    if (opts.source === "isbndb" && !key) throw new ValidationError("ISBNdb has no API key: set ISBNDB_API_KEY in the env file");
    const store = this.deps.isbndbRecords;
    // Only ISBNdb picked by name calls its API (fresh, even for a kept record); otherwise the kept
    // records answer first (even without a key), at no cost.
    const fresh = opts.source === "isbndb";
    const useIsbndb = !!key && fresh;
    const attempt = async (label: string, fn: () => Promise<MetadataCandidate | MetadataCandidate[] | null>) => {
      try {
        const r = await fn();
        if (Array.isArray(r)) out.push(...r);
        else if (r) out.push(r);
      } catch (err) {
        if (rethrowRateLimits && err instanceof RateLimitedError) throw err;
        // A used-up daily quota isn't the book's fault: in bulk runs the other sources simply take over.
        if (rethrowRateLimits && err instanceof QuotaExceededError) return;
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const q = opts.q?.trim();
    const isbn = q ? normalizeIsbn(q) : book.isbn13;
    const doi = q ? normalizeDoi(q) : book.doi;
    // ISBNdb first (kept records, or its API when picked); Open Library when it has nothing.
    if (isbn && useIsbndb) await attempt("ISBNdb", () => isbndbByIsbn(http, key!, store, isbn, fresh));
    else if (isbn && wants("isbndb")) await attempt("ISBNdb records", async () => keptByIsbn(store, isbn));
    if (isbn && !out.length && wants("openlibrary")) await attempt("Open Library", () => openLibraryByIsbn(http, isbn));
    if (doi && wants("doi")) await attempt("DOI", () => lookupDoi(http, doi));

    // Typed identifiers are exact: no fallback search. Otherwise search when identifiers found nothing.
    const typedId = !!q && (!!normalizeIsbn(q) || !!normalizeDoi(q));
    if (out.length === 0 && !typedId) {
      const query = q ? { q } : { title: book.title, author: book.authors[0] ?? null };
      const kept = fresh || !wants("isbndb") ? null : isbndbKeptSearch(store, query);
      if (kept?.sure || (kept && !useIsbndb)) out.push(...kept.candidates);
      else if (useIsbndb) await attempt("ISBNdb search", () => isbndbSearch(http, key!, store, query, 8, fresh));
      if (!out.length && wants("openlibrary")) await attempt("Open Library search", () => openLibrarySearch(http, query));
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
    if (!c || (c.source !== "isbndb" && c.source !== "openlibrary" && c.source !== "doi") || !c.metadata) throw new ValidationError("Invalid candidate");
    const fields = (req.fields ?? []).filter((f): f is MetadataField => (METADATA_FIELDS as readonly string[]).includes(f));

    // Hand edits first, so a field also chosen from the candidate takes the candidate's value.
    const edits = Object.fromEntries(
      Object.entries(req.edits ?? {}).filter(([f, v]) => (EDITABLE_FIELDS as readonly string[]).includes(f) && v !== undefined),
    ) as BookUpdate;
    const fromCandidate = Object.fromEntries(
      fields
        .map((f) => [f, c.metadata[f]] as const)
        // accepting never clears a field
        .filter(([, v]) => !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0))),
    ) as BookUpdate;
    const patch: BookUpdate = { ...edits, ...fromCandidate };
    if (patch.series === undefined && patch.seriesIndex !== undefined && !this.deps.books.get(bookId)?.series) delete patch.seriesIndex;

    // Fetch the cover before touching anything, so a failed download doesn't half-apply. An ISBNdb
    // cover already downloaded with its record is taken from disk.
    const keptCover = req.cover && c.source === "isbndb" ? this.deps.isbndbCovers.read(c.id) : null;
    const cover = keptCover ?? (req.cover && c.coverUrl ? await this.downloadCover(c.coverUrl) : null);

    const result = await this.deps.bookService.update(bookId, patch, {
      confirm: c.source,
      ...(c.source === "openlibrary" && c.match !== "search" ? { olEditionKey: c.olEditionKey, olWorkKey: c.olWorkKey } : {}),
      ...(c.source === "openlibrary" && c.match === "search" ? { olWorkKey: c.olWorkKey } : {}),
    });
    if (cover && (await this.deps.covers.save(bookId, { data: cover, mime: "image/jpeg" }))) {
      this.deps.books.setHasCover(bookId, true, c.source);
      result.book = { ...result.book, hasCover: true };
    }
    this.removeFromQueue(bookId);
    this.deps.events.libraryChanged([bookId]);
    return result;
  }

  /** Only Open Library and ISBNdb covers are fetched; for Open Library, `default=false` makes a missing image a 404 instead of a blank. */
  private async downloadCover(coverUrl: string): Promise<Uint8Array | null> {
    let url: URL;
    try {
      url = new URL(coverUrl);
    } catch {
      throw new ValidationError("Cover URL not allowed");
    }
    if (url.protocol !== "https:" || !COVER_HOSTS.has(url.host)) throw new ValidationError("Cover URL not allowed");
    if (url.host === "covers.openlibrary.org") url.searchParams.set("default", "false");
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

  /**
   * Queue books for background lookup; results land in the review queue. The queue is stored
   * in the database and worked through one book at a time at the services' allowed pace;
   * when a service rate-limits us it pauses until the service accepts requests again.
   */
  enqueue(ids: number[]): LookupQueueStatus {
    const { db, library } = this.deps;
    db.transaction(() => {
      let run = this.currentRun();
      if (this.countPending() === 0) {
        // The previous run is over: start a new one (its jobs stay readable for a day).
        run++;
        db.query(`DELETE FROM lookup_jobs WHERE state != 'pending' AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${OLD_JOB_RETENTION}')`).run();
        this.durations = [];
      }
      const add = db.query(
        `INSERT INTO lookup_jobs (book_id, run) VALUES (?, ?)
         ON CONFLICT(book_id) DO UPDATE SET state = 'pending', error = NULL, finished_at = NULL, run = excluded.run,
           id = (SELECT MAX(id) + 1 FROM lookup_jobs)
         WHERE state != 'pending'`,
      );
      for (const id of new Set(ids)) if (library.index.hasBook(id)) add.run(id, run);
    })();
    void this.drain();
    this.emitStatus();
    return this.status();
  }

  /** Drop the books still waiting (the one being looked up finishes). */
  cancel(): LookupQueueStatus {
    this.deps.db.query("DELETE FROM lookup_jobs WHERE state = 'pending'").run();
    this.wake?.();
    this.emitStatus();
    return this.status();
  }

  /** Queue the books of this run whose lookup failed again. */
  retryFailed(): LookupQueueStatus {
    this.deps.db
      .query("UPDATE lookup_jobs SET state = 'pending', error = NULL, finished_at = NULL WHERE state = 'failed' AND run = ?")
      .run(this.currentRun());
    void this.drain();
    this.emitStatus();
    return this.status();
  }

  status(): LookupQueueStatus {
    const counts: Record<JobState, number> = { pending: 0, done: 0, no_match: 0, failed: 0 };
    const rows = this.deps.db
      .query("SELECT state, COUNT(*) AS n FROM lookup_jobs WHERE run = ? OR state = 'pending' GROUP BY state")
      .all(this.currentRun()) as { state: JobState; n: number }[];
    for (const r of rows) counts[r.state] = r.n;
    const pending = counts.pending;
    const pause = this.pause && this.pause.until > Date.now() ? this.pause : null;
    let etaSeconds: number | null = null;
    if (pending && this.durations.length) {
      const avg = this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
      etaSeconds = Math.round((avg * pending + (pause ? pause.until - Date.now() : 0)) / 1000);
    }
    return {
      running: pending > 0,
      pending,
      done: counts.done + counts.no_match + counts.failed,
      failed: counts.failed,
      noMatch: counts.no_match,
      reviewCount: this.reviewCount(),
      pausedUntil: pause ? new Date(pause.until).toISOString() : null,
      pausedBy: pause?.by ?? null,
      waitingForLibrary: pending > 0 && this.waitingForLibrary,
      etaSeconds,
      currentBookId: pending > 0 ? this.currentBookId : null,
    };
  }

  /** The lookup job of each book (null: none, e.g. never queued or cancelled). */
  jobs(ids: number[]): Record<number, LookupJobDto | null> {
    const out: Record<number, LookupJobDto | null> = {};
    for (const id of ids) out[id] = null;
    if (!ids.length) return out;
    const rows = this.deps.db
      .query(
        `SELECT j.book_id, j.state, j.error,
           CASE WHEN j.state = 'pending' THEN (SELECT COUNT(*) FROM lookup_jobs p WHERE p.state = 'pending' AND p.id < j.id) ELSE 0 END AS position
         FROM lookup_jobs j WHERE j.book_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as { book_id: number; state: JobState; error: string | null; position: number }[];
    for (const r of rows) out[r.book_id] = { state: r.state, position: r.position, error: r.error };
    return out;
  }

  private currentRun(): number {
    return (this.deps.db.query("SELECT COALESCE(MAX(run), 0) AS run FROM lookup_jobs").get() as { run: number }).run;
  }

  /** Waits for the background worker to finish (tests). */
  async idle(): Promise<void> {
    while (this.working) await Bun.sleep(20);
  }

  /** Stop the worker (shutdown); pending books stay queued for the next start. */
  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private countPending(): number {
    return (this.deps.db.query("SELECT COUNT(*) AS n FROM lookup_jobs WHERE state = 'pending'").get() as { n: number }).n;
  }

  private finish(jobId: number, state: JobState, error: string | null = null): void {
    this.deps.db
      .query("UPDATE lookup_jobs SET state = ?, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(state, error, jobId);
  }

  /** Sleep that cancel()/stop() can cut short. */
  private rest(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.wake = done;
    });
  }

  private async drain(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    const { db, library, books, http } = this.deps;
    try {
      while (!this.stopped) {
        const job = db.query("SELECT id, book_id FROM lookup_jobs WHERE state = 'pending' ORDER BY id LIMIT 1").get() as
          | { id: number; book_id: number }
          | null;
        if (!job) break;

        const ready = library.status().state === "ready";
        if (ready !== !this.waitingForLibrary) {
          this.waitingForLibrary = !ready;
          this.emitStatus();
        }
        if (!ready) {
          await this.rest(2000);
          continue;
        }

        const book = library.index.hasBook(job.book_id) ? books.get(job.book_id) : null;
        if (!book) {
          db.query("DELETE FROM lookup_jobs WHERE id = ?").run(job.id);
          continue;
        }
        const started = Date.now();
        this.currentBookId = book.id;
        this.emitStatus();
        try {
          const { candidates, errors } = await http.background(() => this.findCandidates(book, {}, true));
          if (candidates.length) {
            db.query(
              `INSERT INTO review_queue (book_id, payload) VALUES (?, ?)
               ON CONFLICT(book_id) DO UPDATE SET payload = excluded.payload, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
            ).run(book.id, JSON.stringify(candidates));
            this.finish(job.id, "done");
          } else if (errors.length) this.finish(job.id, "failed", errors.join("; "));
          else this.finish(job.id, "no_match");
          this.durations = [...this.durations, Date.now() - started].slice(-ETA_WINDOW);
        } catch (err) {
          if (err instanceof RateLimitedError) {
            // Not the book's fault: keep it first in line and wait until the service accepts requests.
            this.pause = { until: err.retryAt, by: serviceName(err.host) };
            console.warn(`Metadata lookups paused until ${new Date(err.retryAt).toISOString()}: ${err.message}`);
            this.emitStatus();
            await this.rest(err.retryAt - Date.now());
            this.pause = null;
            this.emitStatus();
            continue;
          }
          this.finish(job.id, "failed", err instanceof Error ? err.message : String(err));
        } finally {
          this.currentBookId = null;
        }
        this.emitStatus();
      }
    } finally {
      this.working = false;
      this.pause = null;
      this.waitingForLibrary = false;
      this.currentBookId = null;
      if (!this.stopped) this.emitStatus();
    }
  }

  /** The plan behind the ISBNdb key and today's quota (free: not charged); null without a key. */
  async isbndbKey(): Promise<IsbndbKeyDto | null> {
    const key = this.deps.isbndb.apiKey;
    return key ? isbndbKeyInfo(this.deps.http, key) : null;
  }

  private emitStatus(): void {
    this.deps.events.emit({ type: "lookup.status", status: this.status() });
  }
}
