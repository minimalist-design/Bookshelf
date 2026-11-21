/**
 * ISBNdb (API v2, spec in docs/isbndb-openapi.json): book records by ISBN or by a title/author
 * search. Needs an API key (`ISBNDB_API_KEY`); every call counts against the plan's daily quota,
 * so lookups call it only when the user picks ISBNdb by name.
 *
 * Every record a call returns is kept for good in the local copy (`db/repo/isbndbRecords.ts`), search
 * results that were the wrong book included, and an ISBN lookup reads that copy before asking
 * ISBNdb: what the quota paid for once never has to be fetched again.
 */
import { formatEdition } from "../../shared/edition.ts";
import type { CandidateMetadata, MetadataCandidate } from "../../shared/types.ts";
import { htmlToText } from "../extract/text.ts";
import { toDisplayName } from "../naming/authors.ts";
import type { IsbndbRecord, IsbndbVia } from "../db/repo/isbndbRecords.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { HttpError, ISBNDB_HOST, type HttpClient } from "./http.ts";
import { cleanSubjects, normalizeLanguage, parseLooseDate } from "./normalize.ts";

const API = `https://${ISBNDB_HOST}`;
const SITE = "https://isbndb.com";
/** A search costs one call however many results it returns: ask for the most a page allows, and keep them all. */
const SEARCH_PAGE_SIZE = 100;

/** The local copy of records the lookups read and fill in. */
export interface IsbndbStore {
  get(isbn13: string): IsbndbRecord | null;
  /** Store records (those without an ISBN-13 are skipped); returns how many were stored. */
  putMany(records: readonly IsbndbRecord[], via: IsbndbVia, isbnOf: (r: IsbndbRecord) => string | null): number;
  /** Records whose title or authors contain `word` (any case). */
  containing(word: string, limit?: number): IsbndbRecord[];
}

/** A record's ISBN-13 (its key in the local copy). */
export const isbnOfRecord = (r: IsbndbRecord): string | null =>
  normalizeIsbn(typeof r.isbn13 === "string" ? r.isbn13 : typeof r.isbn === "string" ? r.isbn : null);

/** A book record; fields with no value are left out (the spec marks most of them optional). */
interface IsbndbBook {
  title?: string;
  isbn13?: string;
  isbn?: string;
  publisher?: string;
  language?: string;
  date_published?: string;
  edition_number?: number;
  edition?: string;
  pages?: number;
  binding?: string;
  synopsis?: string;
  image?: string;
  authors?: string[];
  genres?: string[];
  subjects?: string[];
  thema?: { name?: string; type?: string; main?: boolean }[];
}

export interface IsbndbKeyInfo {
  planName: string;
  bulkLimit: number;
  /** The plan's daily allowance, what is spent and left today (shared by every key of the subscription). */
  total: number;
  spent: number;
  left: number;
}

const auth = (apiKey: string) => ({ headers: { Authorization: apiKey } });

/** GET of JSON; null for 404. */
async function getJson<T>(http: HttpClient, url: string, apiKey: string): Promise<T | null> {
  const res = await http.get(url, "application/json", auth(apiKey));
  if (res.status === 404) return null;
  if (res.status !== 200) throw new HttpError(`ISBNdb answered ${res.status}${errorText(res.body)}`, res.status);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new HttpError("ISBNdb returned invalid JSON", res.status);
  }
}

/** The URL of one book. */
export const isbndbBookUrl = (isbn13: string) => `${API}/book/${isbn13}`;

const label = (parts: readonly (string | number | null | undefined)[]) =>
  ["ISBNdb", ...parts.filter((p) => p !== null && p !== undefined && p !== "")].join(" · ");

/** Tags: ISBNdb's genres (short, curated), else the main Thema subjects, else the deprecated subjects. */
function tagsOf(b: IsbndbBook): string[] {
  if (b.genres?.length) return cleanSubjects(b.genres);
  const thema = (b.thema ?? []).filter((t) => t.type === "subject").map((t) => t.name);
  return cleanSubjects(thema.length ? thema : (b.subjects ?? []));
}

/** One record as a lookup candidate; null for a record without a title or ISBN-13. */
export function isbndbCandidate(b: IsbndbBook, match: MetadataCandidate["match"]): MetadataCandidate | null {
  const isbn13 = normalizeIsbn(b.isbn13 ?? b.isbn);
  const title = b.title?.replace(/\s+/g, " ").trim();
  if (!isbn13 || !title) return null;
  const edition = b.edition_number && b.edition_number > 1 ? String(b.edition_number) : null;
  const m: CandidateMetadata = {
    title,
    subtitle: null,
    authors: (b.authors ?? []).map((a) => toDisplayName(a)).filter(Boolean),
    isbn13,
    doi: null,
    publisher: b.publisher?.trim() || null,
    edition,
    publishedDate: parseLooseDate(b.date_published),
    language: normalizeLanguage(b.language),
    pages: b.pages && b.pages > 0 ? b.pages : null,
    description: htmlToText(b.synopsis),
    series: null,
    seriesIndex: null,
    tags: tagsOf(b),
  };
  return {
    source: "isbndb",
    match,
    id: isbn13,
    url: `${SITE}/book/${isbn13}`,
    label: label([m.publisher, b.binding, edition ? formatEdition(edition) : null, m.publishedDate?.slice(0, 4), m.pages ? `${m.pages} pages` : null]),
    metadata: m,
    coverUrl: b.image?.startsWith("https://") ? b.image : null,
    olEditionKey: null,
    olWorkKey: null,
  };
}

/** A kept record as a candidate (no call made). */
export function keptByIsbn(store: IsbndbStore, isbn13: string): MetadataCandidate | null {
  const kept = store.get(isbn13);
  const c = kept ? isbndbCandidate(kept as IsbndbBook, "isbn") : null;
  return c && { ...c, kept: true };
}

/**
 * One book by ISBN: from the local copy when ISBNdb sent it before (by any call), else asked.
 * `fresh` asks ISBNdb even for a kept record, and keeps its newer answer.
 */
export async function isbndbByIsbn(http: HttpClient, apiKey: string, store: IsbndbStore, isbn13: string, fresh = false): Promise<MetadataCandidate | null> {
  const kept = fresh ? null : keptByIsbn(store, isbn13);
  if (kept) return kept;
  const data = await getJson<{ book?: IsbndbRecord }>(http, isbndbBookUrl(isbn13), apiKey);
  if (!data?.book) return null;
  store.putMany([data.book], "book", isbnOfRecord);
  return isbndbCandidate(data.book as IsbndbBook, "isbn");
}

/**
 * Title/author search (one daily call, whatever the page size). Typed text searches every column;
 * a book's own data searches by title. Every result is kept in the local copy (also the ones
 * beyond `limit`, and the wrong books), and the best `limit` become candidates.
 */
export async function isbndbSearch(
  http: HttpClient,
  apiKey: string,
  store: IsbndbStore,
  query: { title?: string | null; author?: string | null; q?: string | null },
  limit = 8,
): Promise<MetadataCandidate[]> {
  const text = (query.q ?? [query.title, query.author].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim().slice(0, 150);
  if (!text) return [];
  const params = new URLSearchParams({
    page: "1",
    pageSize: String(SEARCH_PAGE_SIZE),
    ...(!query.q && query.title ? { column: "title", shouldMatchAll: "true" } : {}),
  });
  // With a title-only column the author would never match: search the title, keep the author for ranking.
  const path = !query.q && query.title ? query.title.trim().slice(0, 150) : text;
  const data = await getJson<{ books?: IsbndbRecord[] }>(http, `${API}/books/${encodeURIComponent(path)}?${params}`, apiKey);
  const records = data?.books ?? [];
  store.putMany(records, "search", isbnOfRecord);
  const author = query.author?.toLowerCase().split(/\s+/).at(-1) ?? null;
  const candidates = records.map((b) => isbndbCandidate(b as IsbndbBook, "search")).filter((c): c is MetadataCandidate => c !== null);
  // The book's author first (by surname), keeping ISBNdb's order otherwise.
  const ranked = author ? candidates.toSorted((a, b) => Number(hasAuthor(b, author)) - Number(hasAuthor(a, author))) : candidates;
  return ranked.slice(0, limit);
}

const hasAuthor = (c: MetadataCandidate, surname: string) => c.metadata.authors.some((a) => a.toLowerCase().includes(surname));

/** Words for matching: case, accents and punctuation ignored. */
const words = (s: string): string[] =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** A title's words without its subtitle ("Dune: Deluxe Edition" → dune). */
const titleWords = (t: string): string[] => words(t.split(":")[0]!);

/**
 * Search the kept records the way an ISBNdb search would: records with every searched word in
 * their title or authors, the surest first. `sure` says whether one of them is the book asked for,
 * in which case ISBNdb needn't be asked:
 * - a book's own title and author: a record with exactly that title (subtitle aside) by an author
 *   with that surname;
 * - typed text: a record whose title is exactly the text without its authors' names
 *   ("dune frank herbert" → Dune, but not Dune Messiah).
 */
export function isbndbKeptSearch(
  store: Pick<IsbndbStore, "containing">,
  query: { title?: string | null; author?: string | null; q?: string | null },
  limit = 8,
): { candidates: MetadataCandidate[]; sure: boolean } {
  const typed = query.q?.trim() ? words(query.q) : null;
  const wantedTitle = typed ? null : titleWords(query.title ?? "");
  const surname = typed || !query.author ? null : (words(query.author).at(-1) ?? null);
  const searched = typed ?? [...wantedTitle!, ...(surname ? [surname] : [])];
  if (!searched.length) return { candidates: [], sure: false };

  const seed = searched.reduce((longest, w) => (w.length > longest.length ? w : longest));
  const authorWords = (r: IsbndbRecord) => (r.authors ?? []).flatMap((a) => words(a));
  const matches = store.containing(seed).filter((r) => {
    const all = new Set([...words(r.title ?? ""), ...authorWords(r)]);
    return searched.every((w) => all.has(w));
  });
  const isIt = (r: IsbndbRecord): boolean => {
    const title = titleWords(r.title ?? "").join(" ");
    if (wantedTitle) return title === wantedTitle.join(" ") && (!surname || authorWords(r).includes(surname));
    const names = new Set(authorWords(r));
    return searched.filter((w) => !names.has(w)).join(" ") === title;
  };
  const ranked = matches.toSorted((a, b) => Number(isIt(b)) - Number(isIt(a)));
  const candidates = ranked
    .map((r) => isbndbCandidate(r as IsbndbBook, "search"))
    .filter((c): c is MetadataCandidate => c !== null)
    .slice(0, limit)
    .map((c) => ({ ...c, kept: true }));
  return { candidates, sure: matches.some(isIt) };
}

/** The plan behind the key and today's quota; free (not charged against the daily limit). */
export async function isbndbKeyInfo(http: HttpClient, apiKey: string): Promise<IsbndbKeyInfo> {
  const res = await http.get(`${API}/key`, "application/json", { ...auth(apiKey), cost: 0 });
  if (res.status !== 200) throw new HttpError(`ISBNdb answered ${res.status}${errorText(res.body)}`, res.status);
  const k = JSON.parse(res.body) as { plan_name?: string; bulk_limit?: number; plan_limit?: { total?: number; spent?: number; left?: number } };
  return {
    planName: k.plan_name ?? "unknown",
    bulkLimit: k.bulk_limit ?? 0,
    total: k.plan_limit?.total ?? 0,
    spent: k.plan_limit?.spent ?? 0,
    left: k.plan_limit?.left ?? 0,
  };
}

/** ": Bad credentials." from an error body (`errorMessage`, or `message` for older answers). */
function errorText(body: string): string {
  try {
    const e = JSON.parse(body) as { errorMessage?: string; message?: string };
    const m = e.errorMessage ?? e.message;
    return m ? `: ${m}` : "";
  } catch {
    return "";
  }
}
