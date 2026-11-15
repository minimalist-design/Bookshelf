import { formatEdition } from "../../shared/edition.ts";
import type { CandidateMetadata, CoverOption, MetadataCandidate } from "../../shared/types.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import type { HttpClient } from "./http.ts";
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

function label(parts: (string | number | null | undefined)[]): string {
  return ["Open Library", ...parts.filter((p) => p !== null && p !== undefined && p !== "")].join(" · ");
}

/** Edition by ISBN (+ its edition record and work for language, series, description). */
export async function openLibraryByIsbn(http: HttpClient, isbn13: string): Promise<MetadataCandidate | null> {
  const data = await http.getJson<Record<string, OlBooksData>>(`${OL}/api/books?bibkeys=ISBN:${isbn13}&jscmd=data&format=json`);
  const rec = data?.[`ISBN:${isbn13}`];
  if (!rec?.title) return null;

  const m = empty();
  m.title = rec.title.trim();
  m.subtitle = rec.subtitle?.trim() || null;
  m.authors = (rec.authors ?? []).map((a) => a.name?.trim() ?? "").filter(Boolean);
  m.isbn13 = normalizeIsbn(rec.identifiers?.isbn_13?.[0]) ?? isbn13;
  m.publisher = rec.publishers?.[0]?.name?.trim() || null;
  m.publishedDate = parseLooseDate(rec.publish_date);
  m.pages = rec.number_of_pages && rec.number_of_pages > 0 ? rec.number_of_pages : null;
  m.tags = cleanSubjects((rec.subjects ?? []).map((s) => s.name));

  const editionKey = rec.identifiers?.openlibrary?.[0] ?? null;
  let workKey: string | null = null;
  let coverUrl = rec.cover?.large ?? null;
  if (editionKey) {
    const ed = await http.getJson<OlEdition>(`${OL}/books/${editionKey}.json`).catch(() => null);
    if (ed) {
      m.subtitle ??= ed.subtitle?.trim() || null;
      m.edition = ed.edition_name?.replace(/\s+/g, " ").trim() || null;
      m.language = normalizeLanguage(ed.languages?.[0]?.key);
      const series = parseSeries(ed.series?.[0]);
      m.series = series.series;
      m.seriesIndex = series.seriesIndex;
      m.description = cleanDescription(text(ed.description));
      workKey = ed.works?.[0]?.key?.replace("/works/", "") ?? null;
      if (!coverUrl && ed.covers?.[0] && ed.covers[0] > 0) coverUrl = olCoverUrl(ed.covers[0]);
    }
  }
  if (workKey && (!m.description || !m.tags.length)) {
    const work = await http.getJson<OlWork>(`${OL}/works/${workKey}.json`).catch(() => null);
    if (work) {
      m.description ??= cleanDescription(text(work.description));
      if (!m.tags.length) m.tags = cleanSubjects(work.subjects ?? []);
    }
  }

  return {
    source: "openlibrary",
    match: "isbn",
    id: editionKey ?? `ISBN:${isbn13}`,
    url: editionKey ? `${OL}/books/${editionKey}` : (rec.url ?? `${OL}/isbn/${isbn13}`),
    label: label([m.publisher, m.edition ? formatEdition(m.edition) : null, m.publishedDate?.slice(0, 4), m.pages ? `${m.pages} pages` : null]),
    metadata: m,
    coverUrl,
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
  });
  if (query.q) params.set("q", query.q);
  else {
    if (query.title) params.set("title", query.title);
    if (query.author) params.set("author", query.author);
  }
  const res = await http.getJson<{ docs?: OlSearchDoc[] }>(`${OL}/search.json?${params}`);
  return (res?.docs ?? [])
    .filter((d) => d.title)
    .map((d) => {
      const m = empty();
      m.title = d.title!.trim();
      m.subtitle = d.subtitle?.trim() || null;
      m.authors = d.author_name ?? [];
      m.publishedDate = d.first_publish_year ? String(d.first_publish_year) : null;
      m.pages = d.number_of_pages_median ?? null;
      m.tags = cleanSubjects(d.subject ?? []);
      m.language = d.language?.length === 1 ? normalizeLanguage(d.language[0]) : null;
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
export async function openLibraryEditionCovers(http: HttpClient, workKey: string, authors: string[]): Promise<CoverOption[]> {
  // One request: the endpoint accepts a large limit (popular works have a few hundred editions).
  const res = await http.getJson<{ entries?: OlEditionEntry[] }>(`${OL}/works/${encodeURIComponent(workKey)}/editions.json?limit=1000`);
  const out: CoverOption[] = [];
  for (const e of res?.entries ?? []) {
    const ids = (e.covers ?? []).filter((id) => id > 0);
    if (!ids.length || !e.title) continue;
    const isbn13 = normalizeIsbn(e.isbn_13?.[0]) ?? normalizeIsbn(e.isbn_10?.[0]);
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
    for (const id of ids) {
      out.push({
        coverUrl: olCoverUrl(id),
        url: `${OL}${e.key}`,
        title: e.title.trim(),
        subtitle: e.subtitle?.trim() || null,
        authors,
        details,
        language: normalizeLanguage(e.languages?.[0]?.key),
        isbn13,
        thisEdition: false,
      });
    }
  }
  return out;
}
