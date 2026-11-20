import { formatEdition } from "../../shared/edition.ts";
import type { AuthorMatchDto, CandidateMetadata, CoverOption, MetadataCandidate } from "../../shared/types.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { RateLimitedError, type HttpClient } from "./http.ts";
import { cleanSubjects, normalizeLanguage, parseLooseDate, parseSeries } from "./normalize.ts";

const OL = "https://openlibrary.org";
const COVERS = "https://covers.openlibrary.org";

interface OlBooksData {
  title?: string;
  subtitle?: string;
  authors?: { name?: string }[];
  publishers?: { name?: string }[];
  publish_date?: string;
  number_of_pages?: number;
  subjects?: { name?: string }[];
  cover?: { large?: string; medium?: string };
  identifiers?: { isbn_13?: string[]; isbn_10?: string[]; openlibrary?: string[] };
  url?: string;
}
interface OlEdition {
  subtitle?: string;
  edition_name?: string;
  works?: { key: string }[];
  languages?: { key: string }[];
  series?: string[];
  description?: string | { value?: string };
  covers?: number[];
}
interface OlWork {
  description?: string | { value?: string };
  subjects?: string[];
}
interface OlSearchDoc {
  key: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  cover_edition_key?: string;
  number_of_pages_median?: number;
  subject?: string[];
  language?: string[];
}

interface OlEditionEntry {
  key: string;
  title?: string;
  subtitle?: string;
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  edition_name?: string;
  physical_format?: string;
  covers?: number[];
  isbn_13?: string[];
  isbn_10?: string[];
  languages?: { key: string }[];
}

export const olCoverUrl = (id: number, size: "S" | "M" | "L" = "L") => `${COVERS}/b/id/${id}-${size}.jpg`;

/** Optional extra record: missing or broken is fine, but a rate limit must reach the caller. */
const optional = <T>(p: Promise<T | null>): Promise<T | null> =>
  p.catch((err) => {
    if (err instanceof RateLimitedError) throw err;
    return null;
  });

const text = (v: string | { value?: string } | undefined | null): string | null => {
  const s = typeof v === "string" ? v : v?.value;
  return s?.replace(/\r\n/g, "\n").trim() || null;
};

/** Strip Open Library's markdown-ish source notes ("([source][1])", "----------\n**Contains**…"). */
function cleanDescription(s: string | null): string | null {
  if (!s) return null;
  const cut = s.split(/\n-{3,}\s*\n|\n\s*\[\d+\]:/)[0]!;
  return cut.replace(/\(\[source\]\[\d+\]\)/gi, "").replace(/\s+\n/g, "\n").trim() || null;
}

function empty(): CandidateMetadata {
  return {
    title: null, subtitle: null, authors: [], isbn13: null, doi: null, publisher: null, edition: null, publishedDate: null,
    language: null, pages: null, description: null, series: null, seriesIndex: null, tags: [],
  };
}

function label(parts: readonly (string | number | null | undefined)[]): string {
  return ["Open Library", ...parts.filter((p) => p !== null && p !== undefined && p !== "")].join(" · ");
}

const hasTitle = (rec: OlBooksData | undefined): rec is OlBooksData & { title: string } => !!rec?.title;

/** What the books API record says about the edition. */
function fromBooksData(rec: OlBooksData & { title: string }, isbn13: string): CandidateMetadata {
  return {
    ...empty(),
    title: rec.title.trim(),
    subtitle: rec.subtitle?.trim() || null,
    authors: (rec.authors ?? []).map((a) => a.name?.trim() ?? "").filter(Boolean),
    isbn13: normalizeIsbn(rec.identifiers?.isbn_13?.[0]) ?? isbn13,
    publisher: rec.publishers?.[0]?.name?.trim() || null,
    publishedDate: parseLooseDate(rec.publish_date),
    pages: rec.number_of_pages && rec.number_of_pages > 0 ? rec.number_of_pages : null,
    tags: cleanSubjects((rec.subjects ?? []).map((s) => s.name)),
  };
}

/** The edition record adds edition, language, series and description; a subtitle only fills a gap. */
function withEdition(m: CandidateMetadata, ed: OlEdition): CandidateMetadata {
  const { series, seriesIndex } = parseSeries(ed.series?.[0]);
  return {
    ...m,
    subtitle: m.subtitle ?? (ed.subtitle?.trim() || null),
    edition: ed.edition_name?.replace(/\s+/g, " ").trim() || null,
    language: normalizeLanguage(ed.languages?.[0]?.key),
    series,
    seriesIndex,
    description: cleanDescription(text(ed.description)),
  };
}

/** The work fills a missing description and missing tags. */
function withWork(m: CandidateMetadata, work: OlWork): CandidateMetadata {
  return {
    ...m,
    description: m.description ?? cleanDescription(text(work.description)),
    tags: m.tags.length ? m.tags : cleanSubjects(work.subjects ?? []),
  };
}

const workKeyOf = (ed: OlEdition | null): string | null => ed?.works?.[0]?.key?.replace("/works/", "") ?? null;
const editionCoverUrl = (ed: OlEdition | null): string | null => {
  const id = ed?.covers?.[0];
  return id && id > 0 ? olCoverUrl(id) : null;
};

/** Edition by ISBN (+ its edition record and work for language, series, description). */
export async function openLibraryByIsbn(http: HttpClient, isbn13: string): Promise<MetadataCandidate | null> {
  const data = await http.getJson<Record<string, OlBooksData>>(`${OL}/api/books?bibkeys=ISBN:${isbn13}&jscmd=data&format=json`);
  const rec = data?.[`ISBN:${isbn13}`];
  if (!hasTitle(rec)) return null;

  const editionKey = rec.identifiers?.openlibrary?.[0] ?? null;
  const ed = editionKey ? await optional(http.getJson<OlEdition>(`${OL}/books/${editionKey}.json`)) : null;
  const fromEdition = ed ? withEdition(fromBooksData(rec, isbn13), ed) : fromBooksData(rec, isbn13);
  const workKey = workKeyOf(ed);
  const work =
    workKey && (!fromEdition.description || !fromEdition.tags.length)
      ? await optional(http.getJson<OlWork>(`${OL}/works/${workKey}.json`))
      : null;
  const m = work ? withWork(fromEdition, work) : fromEdition;

  return {
    source: "openlibrary",
    match: "isbn",
    id: editionKey ?? `ISBN:${isbn13}`,
    url: editionKey ? `${OL}/books/${editionKey}` : (rec.url ?? `${OL}/isbn/${isbn13}`),
    label: label([m.publisher, m.edition ? formatEdition(m.edition) : null, m.publishedDate?.slice(0, 4), m.pages ? `${m.pages} pages` : null]),
    metadata: m,
    coverUrl: rec.cover?.large ?? editionCoverUrl(ed),
    olEditionKey: editionKey,
    olWorkKey: workKey,
  };
}

/** Work-level search by title/author (or free text). ISBN is left empty: a work spans many editions. */
export async function openLibrarySearch(
  http: HttpClient,
  query: { title?: string | null; author?: string | null; q?: string | null },
  limit = 5,
): Promise<MetadataCandidate[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    fields: "key,title,subtitle,author_name,first_publish_year,cover_i,cover_edition_key,number_of_pages_median,subject,language",
    ...(query.q
      ? { q: query.q }
      : { ...(query.title ? { title: query.title } : {}), ...(query.author ? { author: query.author } : {}) }),
  });
  const res = await http.getJson<{ docs?: OlSearchDoc[] }>(`${OL}/search.json?${params}`);
  return (res?.docs ?? [])
    .filter((d) => d.title)
    .map((d) => {
      const m: CandidateMetadata = {
        ...empty(),
        title: d.title!.trim(),
        subtitle: d.subtitle?.trim() || null,
        authors: d.author_name ?? [],
        publishedDate: d.first_publish_year ? String(d.first_publish_year) : null,
        pages: d.number_of_pages_median ?? null,
        tags: cleanSubjects(d.subject ?? []),
        language: d.language?.length === 1 ? normalizeLanguage(d.language[0]) : null,
      };
      const workKey = d.key.replace("/works/", "");
      return {
        source: "openlibrary" as const,
        match: "search" as const,
        id: workKey,
        url: `${OL}${d.key}`,
        label: label([m.authors[0], d.first_publish_year ? `first published ${d.first_publish_year}` : null]),
        metadata: m,
        coverUrl: d.cover_i && d.cover_i > 0 ? olCoverUrl(d.cover_i) : null,
        olEditionKey: d.cover_edition_key ?? null,
        olWorkKey: workKey,
      };
    });
}

/**
 * Every cover of every edition of a work (editions often have their own cover). Edition records
 * only link to author keys, so the work's author names are passed in.
 */
export async function openLibraryEditionCovers(http: HttpClient, workKey: string, authors: readonly string[]): Promise<CoverOption[]> {
  // One request: the endpoint accepts a large limit (popular works have a few hundred editions).
  const res = await http.getJson<{ entries?: OlEditionEntry[] }>(`${OL}/works/${encodeURIComponent(workKey)}/editions.json?limit=1000`);
  return editionCoverOptions(res?.entries ?? [], authors);
}

/** One cover option per cover image of each edition that has a title. */
function editionCoverOptions(entries: readonly OlEditionEntry[], authors: readonly string[]): CoverOption[] {
  return entries
    .map((e) => ({ e, ids: (e.covers ?? []).filter((id) => id > 0) }))
    .filter((x): x is { e: OlEditionEntry & { title: string }; ids: number[] } => x.ids.length > 0 && !!x.e.title)
    .flatMap(({ e, ids }) => {
      const edition = e.edition_name?.replace(/\s+/g, " ").trim() || null;
      const details = [
        e.publishers?.[0]?.trim(),
        edition ? formatEdition(edition) : null,
        parseLooseDate(e.publish_date)?.slice(0, 4),
        e.number_of_pages && e.number_of_pages > 0 ? `${e.number_of_pages} pages` : null,
        e.physical_format?.trim(),
      ]
        .filter(Boolean)
        .join(" · ");
      const option = {
        url: `${OL}${e.key}`,
        title: e.title.trim(),
        subtitle: e.subtitle?.trim() || null,
        authors,
        details,
        language: normalizeLanguage(e.languages?.[0]?.key),
        isbn13: normalizeIsbn(e.isbn_13?.[0]) ?? normalizeIsbn(e.isbn_10?.[0]),
        thisEdition: false,
      };
      return ids.map((id): CoverOption => ({ coverUrl: olCoverUrl(id), ...option }));
    });
}

interface OlAuthorDoc {
  key?: string;
  name?: string;
  alternate_names?: string[];
  birth_date?: string;
  death_date?: string;
  top_work?: string;
  work_count?: number;
}

/** Authors matching a name, best known first, to pick a reference spelling. */
export async function openLibraryAuthorSearch(http: HttpClient, q: string, limit = 5): Promise<AuthorMatchDto[]> {
  const params = new URLSearchParams({
    q,
    limit: String(limit),
    fields: "key,name,alternate_names,birth_date,death_date,top_work,work_count",
  });
  const res = await http.getJson<{ docs?: OlAuthorDoc[] }>(`${OL}/search/authors.json?${params}`);
  const year = (d: string | undefined) => /\b(\d{3,4})\b/.exec(d ?? "")?.[1] ?? null;
  return (res?.docs ?? [])
    .filter((d): d is OlAuthorDoc & { key: string; name: string } => !!d.key && !!d.name?.trim())
    .map((d) => {
      const key = d.key.replace(/^\/authors\//, "");
      const [born, died] = [year(d.birth_date), year(d.death_date)];
      return {
        source: "openlibrary" as const,
        key,
        name: d.name.replace(/\s+/g, " ").trim(),
        years: born || died ? `${born ?? "?"}–${died ?? ""}` : null,
        description: null,
        topWork: d.top_work?.trim() || null,
        workCount: d.work_count ?? null,
        alternateNames: (d.alternate_names ?? []).slice(0, 5),
        authorities: [],
        url: `${OL}/authors/${key}`,
      };
    });
}
