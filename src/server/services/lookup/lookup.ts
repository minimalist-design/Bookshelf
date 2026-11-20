/**
 * Finds metadata candidates in the kept ISBNdb records (its API only when ISBNdb is picked by
 * name), else Open Library (ISBN, title/author), and the DOI registries (Crossref, doi.org), and
 * applies the fields the user accepts (which confirms the book). Bulk lookups run in the
 * background (`worker.ts`) and collect their results in the review queue; they never call ISBNdb.
 */
import type { AppContext } from "../../app.ts";
import * as coverStore from "../../covers/store.ts";
import * as bookRepo from "../../db/repo/books.ts";
import type { BookRecord } from "../../db/repo/books.ts";
import * as reviewRepo from "../../db/repo/reviewQueue.ts";
import { uniqueBy } from "../../collections.ts";
import { NotFoundError } from "../../api/http.ts";
import { ValidationError } from "../../library/paths.ts";
import { toSummary } from "../../library/queries.ts";
import { applyRules } from "../../metadata/rules.ts";
import { normalizeDoi } from "../../naming/doi.ts";
import { normalizeIsbn } from "../../naming/isbn.ts";
import { diffMetadata } from "../../sources/diff.ts";
import { lookupDoi, searchCrossref } from "../../sources/doi.ts";
import { QuotaExceededError, RateLimitedError } from "../../sources/http.ts";
import { isbndbByIsbn, isbndbKeptSearch, isbndbKeyInfo, isbndbSearch, keptByIsbn } from "../../sources/isbndb.ts";
import { openLibraryByIsbn, openLibraryEditionCovers, openLibrarySearch } from "../../sources/openlibrary.ts";
import * as books from "../books.ts";
import type {
  ApplyMetadataRequest,
  BookActionResult,
  BookUpdate,
  CoverOption,
  CoverSearchResult,
  IsbndbKeyDto,
  LookupResult,
  LookupSource,
  MetadataCandidate,
  MetadataField,
  ReviewItemDto,
} from "../../../shared/types.ts";
import { METADATA_FIELDS } from "../../../shared/types.ts";

export interface LookupOptions {
  /** Restrict to one source (default: whatever fits the book). */
  source?: LookupSource;
  /** Free text, an ISBN or a DOI typed by the user instead of the book's own data. */
  q?: string;
}

/** What asking the sources needs. ISBNdb's API is asked only when picked by name (its calls are paid). */
export type SourceDeps = Pick<AppContext, "http" | "config" | "isbndbStore">;
type ViewDeps = Pick<AppContext, "db" | "library" | "aliases">;
type LookupDeps = ViewDeps & SourceDeps & Pick<AppContext, "events" | "lookup">;
type ApplyDeps = LookupDeps & Pick<AppContext, "config" | "isbndbCovers">;

/** Fields that can be typed in while reviewing a lookup: the metadata, plus the book's own notes. */
const EDITABLE_FIELDS = [...METADATA_FIELDS, "notes"] as const;
const COVER_HOSTS = new Set(["covers.openlibrary.org", "images.isbndb.com"]);
/** Works whose editions are listed in the cover picker (one request each, throttled to 1/s). */
const MAX_EXPANDED_WORKS = 3;

// ---- pure rules --------------------------------------------------------------------

/** Title for matching search results to the book: case, punctuation and subtitle ignored. */
const titleKey = (t: string) => t.toLowerCase().split(":")[0]!.replace(/[^\p{L}\p{N}]+/gu, "");

/** The identifiers to look up: the typed text's, else the book's. A typed identifier is exact (no fallback search). */
export function lookupIds(book: Pick<BookRecord, "isbn13" | "doi">, q: string | undefined): { isbn: string | null; doi: string | null; typedId: boolean } {
  return {
    isbn: q ? normalizeIsbn(q) : book.isbn13,
    doi: q ? normalizeDoi(q) : book.doi,
    typedId: !!q && (!!normalizeIsbn(q) || !!normalizeDoi(q)),
  };
}

const isEmptyValue = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * The update for an accepted candidate: hand edits first, so a field also chosen from the candidate
 * takes the candidate's value. Accepting never clears a field, and a series number without a series
 * is dropped.
 */
export function buildPatch(req: ApplyMetadataRequest, candidate: MetadataCandidate, bookHasSeries: boolean): BookUpdate {
  const fields = (req.fields ?? []).filter((f): f is MetadataField => (METADATA_FIELDS as readonly string[]).includes(f));
  const edits = Object.fromEntries(
    Object.entries(req.edits ?? {}).filter(([f, v]) => (EDITABLE_FIELDS as readonly string[]).includes(f) && v !== undefined),
  ) as BookUpdate;
  const fromCandidate = Object.fromEntries(
    fields.map((f) => [f, candidate.metadata[f]] as const).filter(([, v]) => !isEmptyValue(v)),
  ) as BookUpdate;
  const { seriesIndex, ...patch }: BookUpdate = { ...edits, ...fromCandidate };
  const keepIndex = seriesIndex !== undefined && (patch.series !== undefined || bookHasSeries);
  return keepIndex ? { ...patch, seriesIndex } : patch;
}

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
 * Works whose editions are listed in the cover picker: the edition's own work, then search results
 * with the same title (not sequels etc.), or the first result when nothing else matches. Each with
 * its authors (edition records only link to author keys).
 */
export function worksToExpand(own: MetadataCandidate | null, works: readonly MetadataCandidate[], targetTitle: string): [string, readonly string[]][] {
  const target = titleKey(targetTitle);
  const same = works.filter((w) => titleKey(w.metadata.title ?? "") === target);
  const picked = !own && !same.length && works[0] ? [works[0]] : same;
  const entries = [own, ...picked].flatMap((w): [string, readonly string[]][] => (w?.olWorkKey ? [[w.olWorkKey, w.metadata.authors]] : []));
  return uniqueBy(entries, ([key]) => key);
}

/**
 * The cover picker's options: the book's ISBN edition, the editions of the expanded works (the
 * book's language first), then other search results; each cover once, the book's own edition(s) first.
 */
export function coverOptions(
  book: Pick<BookRecord, "isbn13" | "language">,
  own: MetadataCandidate | null,
  works: readonly MetadataCandidate[],
  editions: readonly CoverOption[],
  expanded: ReadonlySet<string>,
): CoverOption[] {
  const lang = book.language;
  const ordered = lang ? editions.toSorted((a, b) => Number(b.language === lang) - Number(a.language === lang)) : editions;
  const options = [
    ...(own?.coverUrl ? [candidateCover(own)] : []),
    ...ordered,
    ...works.filter((w) => w.coverUrl && !(w.olWorkKey && expanded.has(w.olWorkKey) && editions.length)).map(candidateCover),
  ];
  return uniqueBy(
    options.map((o) => ({ ...o, thisEdition: !!book.isbn13 && o.isbn13 === book.isbn13 })),
    (o) => o.coverUrl,
  ).toSorted((a, b) => Number(b.thisEdition) - Number(a.thisEdition));
}

/** What "accept all fills" applies for a queued book: only missing fields (and a missing cover); null for search matches. */
export function fillRequest(item: ReviewItemDto): ApplyMetadataRequest | null {
  const best = item.result.candidates[0];
  if (!best || best.match === "search") return null;
  return {
    candidate: best,
    fields: best.diff.filter((d) => d.status === "fill").map((d) => d.field),
    cover: !item.book.hasCover && !!best.coverUrl,
  };
}

// ---- asking the sources ------------------------------------------------------------

/** What one source gave: its candidates, or the error to report. */
interface Step<T> {
  value: T;
  errors: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Run one source. With `rethrowRateLimits`, a rate-limited source aborts the whole lookup (to be retried
 * later) and a used-up daily quota is passed over silently (the other sources take over in bulk runs).
 */
async function attempt<T>(label: string, fallback: T, fn: () => Promise<T>, rethrowRateLimits = false): Promise<Step<T>> {
  try {
    return { value: await fn(), errors: [] };
  } catch (err) {
    if (rethrowRateLimits && err instanceof RateLimitedError) throw err;
    if (rethrowRateLimits && err instanceof QuotaExceededError) return { value: fallback, errors: [] };
    return { value: fallback, errors: [`${label}: ${message(err)}`] };
  }
}

const NONE: Step<MetadataCandidate[]> = { value: [], errors: [] };
const list = (r: MetadataCandidate | MetadataCandidate[] | null): MetadataCandidate[] => (Array.isArray(r) ? r : r ? [r] : []);

/** Candidates for a book from every source that fits, with the errors of the sources that failed. */
export async function findCandidates(
  deps: SourceDeps,
  book: BookRecord,
  opts: LookupOptions,
  rethrowRateLimits = false,
): Promise<{ candidates: MetadataCandidate[]; errors: string[] }> {
  const { http, isbndbStore: store } = deps;
  const key = deps.config.isbndb.apiKey;
  if (opts.source === "isbndb" && !key) throw new ValidationError("ISBNdb has no API key: set ISBNDB_API_KEY in the env file");
  const wants = (s: LookupSource) => !opts.source || opts.source === s;
  // Only ISBNdb picked by name calls its API (fresh, even for a kept record); otherwise the kept
  // records answer first (even without a key), at no cost.
  const fresh = opts.source === "isbndb";
  const useIsbndb = !!key && fresh;
  const run = (label: string, fn: () => Promise<MetadataCandidate | MetadataCandidate[] | null>) =>
    attempt(label, [], async () => list(await fn()), rethrowRateLimits);

  const q = opts.q?.trim();
  const { isbn, doi, typedId } = lookupIds(book, q);
  // ISBNdb first (kept records, or its API when picked); Open Library when it has nothing.
  const isbndb =
    isbn && useIsbndb
      ? await run("ISBNdb", () => isbndbByIsbn(http, key!, store, isbn, fresh))
      : isbn && wants("isbndb")
        ? await run("ISBNdb records", async () => keptByIsbn(store, isbn))
        : NONE;
  const openLibrary = isbn && !isbndb.value.length && wants("openlibrary") ? await run("Open Library", () => openLibraryByIsbn(http, isbn)) : NONE;
  const byDoi = doi && wants("doi") ? await run("DOI", () => lookupDoi(http, doi)) : NONE;
  const byId = [isbndb, openLibrary, byDoi];
  const found = byId.flatMap((s) => s.value);

  // Typed identifiers are exact: no fallback search. Otherwise search when identifiers found nothing.
  if (found.length || typedId) return { candidates: found, errors: byId.flatMap((s) => s.errors) };
  const query = q ? { q } : { title: book.title, author: book.authors[0] ?? null };
  const kept = fresh || !wants("isbndb") ? null : isbndbKeptSearch(store, query);
  const isbndbSearched =
    kept?.sure || (kept && !useIsbndb)
      ? { value: kept.candidates, errors: [] }
      : useIsbndb
        ? await run("ISBNdb search", () => isbndbSearch(http, key!, store, query, 8, fresh))
        : NONE;
  const olSearched = !isbndbSearched.value.length && wants("openlibrary") ? await run("Open Library search", () => openLibrarySearch(http, query)) : NONE;
  // Papers and DOI books live in Crossref; skip it for plain book searches when the user picked OL.
  const crossref = wants("doi") ? await run("Crossref search", () => searchCrossref(http, query)) : NONE;
  const steps = [...byId, isbndbSearched, olSearched, crossref];
  return { candidates: steps.flatMap((s) => s.value), errors: steps.flatMap((s) => s.errors) };
}

// ---- reading -----------------------------------------------------------------------

function requireVisible(deps: Pick<AppContext, "db" | "library">, id: number): BookRecord {
  const book = deps.library.index.hasBook(id) ? bookRepo.get(deps.db, id) : null;
  if (!book) throw new NotFoundError(`Book ${id} not found`);
  return book;
}

/** Candidates with the remembered main spelling of names (like imports), each compared with the book. */
export function withDiffs(deps: Pick<AppContext, "aliases">, book: BookRecord, candidates: readonly MetadataCandidate[], errors: readonly string[] = []): LookupResult {
  return {
    bookId: book.id,
    notes: book.notes,
    candidates: candidates
      .map((c) => ({ ...c, metadata: deps.aliases.apply(applyRules(c.metadata)) }))
      .map((c) => ({ ...c, diff: diffMetadata(book, c.metadata) })),
    errors,
  };
}

/** Look a book up now. */
export async function find(deps: ViewDeps & SourceDeps, bookId: number, opts: LookupOptions = {}): Promise<LookupResult> {
  const book = requireVisible(deps, bookId);
  const { candidates, errors } = await findCandidates(deps, book, opts);
  return withDiffs(deps, book, candidates, errors);
}

/** The review queue: books on disk with their stored candidates, oldest first. */
export function reviewItems(deps: ViewDeps): ReviewItemDto[] {
  const { db, library } = deps;
  const rows = reviewRepo.list(db);
  const records = bookRepo.getMany(db, rows.map((r) => r.bookId));
  return rows
    .filter((r) => library.index.hasBook(r.bookId) && records.has(r.bookId))
    .map((r) => {
      const book = records.get(r.bookId)!;
      return { book: toSummary(book, library.index.filesOfBook(book.id)), result: withDiffs(deps, book, r.candidates), createdAt: r.createdAt };
    });
}

export function reviewCount(deps: Pick<AppContext, "db" | "library">): number {
  return reviewRepo.bookIds(deps.db).filter((id) => deps.library.index.hasBook(id)).length;
}

/** Take a book off the review queue. */
export function dismiss(deps: Pick<AppContext, "db" | "lookup">, bookId: number): void {
  if (reviewRepo.remove(deps.db, bookId)) deps.lookup.emitStatus();
}

/** The plan behind the ISBNdb key and today's quota (free: not charged); null without a key. */
export async function isbndbKey(deps: Pick<AppContext, "http" | "config">): Promise<IsbndbKeyDto | null> {
  const key = deps.config.isbndb.apiKey;
  return key ? isbndbKeyInfo(deps.http, key) : null;
}

// ---- applying ----------------------------------------------------------------------

/** Only Open Library and ISBNdb covers are fetched; for Open Library, `default=false` makes a missing image a 404 instead of a blank. */
async function downloadCover(deps: Pick<AppContext, "http">, coverUrl: string): Promise<Uint8Array | null> {
  const url = URL.parse(coverUrl);
  if (!url || url.protocol !== "https:" || !COVER_HOSTS.has(url.host)) throw new ValidationError("Cover URL not allowed");
  if (url.host === "covers.openlibrary.org") url.searchParams.set("default", "false");
  return deps.http.getBytes(url.toString());
}

/** Apply the chosen fields (and optionally the cover) of a candidate; confirms the book. */
export async function apply(deps: ApplyDeps, bookId: number, req: ApplyMetadataRequest): Promise<BookActionResult> {
  const book = requireVisible(deps, bookId);
  const c = req?.candidate;
  if (!c || (c.source !== "isbndb" && c.source !== "openlibrary" && c.source !== "doi") || !c.metadata) throw new ValidationError("Invalid candidate");
  const patch = buildPatch(req, c, !!book.series);

  // Fetch the cover before touching anything, so a failed download doesn't half-apply. An ISBNdb
  // cover already downloaded with its record is taken from disk.
  const keptCover = req.cover && c.source === "isbndb" ? deps.isbndbCovers.read(c.id) : null;
  const cover = keptCover ?? (req.cover && c.coverUrl ? await downloadCover(deps, c.coverUrl) : null);

  const result = await books.update(deps, bookId, patch, {
    confirm: c.source,
    ...(c.source === "openlibrary" && c.match !== "search" ? { olEditionKey: c.olEditionKey, olWorkKey: c.olWorkKey } : {}),
    ...(c.source === "openlibrary" && c.match === "search" ? { olWorkKey: c.olWorkKey } : {}),
  });
  const coverSaved = !!cover && (await coverStore.save(deps.config.coversDir, bookId, { data: cover, mime: "image/jpeg" }));
  if (coverSaved) bookRepo.setHasCover(deps.db, bookId, true, c.source);
  dismiss(deps, bookId);
  deps.events.libraryChanged([bookId]);
  return coverSaved ? { ...result, book: { ...result.book, hasCover: true } } : result;
}

/**
 * Accept, for every queued book whose best candidate matched by ISBN/DOI, only the fields
 * the book is missing (plus the cover when it has none). Search matches are left for review.
 */
export async function acceptAllFills(deps: ApplyDeps): Promise<{ applied: number; skipped: number; errors: string[] }> {
  // One book at a time: each may download a cover.
  const outcomes = await Array.fromAsync(reviewItems(deps), async (item) => {
    const req = fillRequest(item);
    if (!req) return { kind: "skipped" as const };
    try {
      await apply(deps, item.book.id, req);
      return { kind: "applied" as const };
    } catch (err) {
      return { kind: "error" as const, error: `${item.book.title}: ${message(err)}` };
    }
  });
  return {
    applied: outcomes.filter((o) => o.kind === "applied").length,
    skipped: outcomes.filter((o) => o.kind === "skipped").length,
    errors: outcomes.flatMap((o) => (o.kind === "error" ? [o.error] : [])),
  };
}

// ---- covers ------------------------------------------------------------------------

/**
 * Every Open Library cover that could belong to the book: its own ISBN edition first, then the
 * covers of all editions of the matching work(s) (book's language first), then other search
 * results. A typed ISBN starts from that edition; other text replaces the title/author search.
 */
export async function findCovers(deps: Pick<AppContext, "db" | "library" | "http">, bookId: number, q?: string): Promise<CoverSearchResult> {
  const book = requireVisible(deps, bookId);
  const { http } = deps;
  const text = q?.trim();
  const isbn = text ? normalizeIsbn(text) : book.isbn13;
  const own = isbn ? await attempt("Open Library", null, () => openLibraryByIsbn(http, isbn)) : { value: null, errors: [] };
  const works =
    !text || !isbn
      ? await attempt("Open Library search", [], () => openLibrarySearch(http, text ? { q: text } : { title: book.title, author: book.authors[0] ?? null }, 10))
      : { value: [], errors: [] };

  const toExpand = worksToExpand(own.value, works.value, own.value?.metadata.title ?? (text ? works.value[0]?.metadata.title : book.title) ?? "");
  // One request per work, one after the other (the host is paced).
  const editions = await Array.fromAsync(toExpand.slice(0, MAX_EXPANDED_WORKS), ([workKey, authors]) =>
    attempt("Open Library editions", [], () => openLibraryEditionCovers(http, workKey, authors)),
  );
  const options = coverOptions(book, own.value, works.value, editions.flatMap((e) => e.value), new Set(toExpand.map(([key]) => key)));
  return { bookId, options, errors: [own, works, ...editions].flatMap((s) => s.errors) };
}

/** Download a cover picked from a lookup result and make it the book's cover (like an upload). */
export async function setCoverFromUrl(deps: Pick<AppContext, "db" | "library" | "http" | "config" | "events">, bookId: number, coverUrl: unknown): Promise<void> {
  requireVisible(deps, bookId);
  if (typeof coverUrl !== "string" || !coverUrl) throw new ValidationError("Missing cover URL");
  const data = await downloadCover(deps, coverUrl);
  if (!data) throw new ValidationError("Open Library has no image for this cover");
  if (!(await coverStore.save(deps.config.coversDir, bookId, { data, mime: "image/jpeg" }))) throw new ValidationError("The image could not be read");
  bookRepo.setHasCover(deps.db, bookId, true, "openlibrary");
  bookRepo.confirm(deps.db, bookId, "manual");
  deps.events.libraryChanged([bookId]);
}
