import type { CandidateMetadata, MetadataCandidate } from "../../shared/types.ts";
import { htmlToText } from "../extract/text.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import type { HttpClient } from "./http.ts";
import { cleanSubjects, dateFromParts, normalizeLanguage } from "./normalize.ts";

const CROSSREF = "https://api.crossref.org";
const CSL_ACCEPT = "application/vnd.citationstyles.csl+json";

interface Person {
  given?: string;
  family?: string;
  name?: string;
  literal?: string;
}

/** Crossref "message" and CSL-JSON share most field names. */
interface WorkRecord {
  DOI?: string;
  title?: string | string[];
  subtitle?: string | string[];
  author?: Person[];
  editor?: Person[];
  publisher?: string;
  issued?: { "date-parts"?: unknown };
  published?: { "date-parts"?: unknown };
  ISBN?: string | string[];
  "isbn-type"?: { value: string; type: string }[];
  type?: string;
  "container-title"?: string | string[];
  abstract?: string;
  subject?: string[];
  categories?: string[];
  language?: string;
}

const first = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.replace(/\s+/g, " ").trim() || null;
};

function personName(p: Person): string {
  return (p.literal ?? p.name ?? [p.given, p.family].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
}

function toCandidate(w: WorkRecord, doi: string, via: "crossref" | "doi.org", match: "doi" | "search"): MetadataCandidate | null {
  const title = first(w.title);
  if (!title) return null;
  const isbns = [...(w["isbn-type"]?.map((i) => i.value) ?? []), ...(Array.isArray(w.ISBN) ? w.ISBN : w.ISBN ? [w.ISBN] : [])];
  const people = (w.author?.length ? w.author : (w.editor ?? [])).map(personName).filter(Boolean);
  const m: CandidateMetadata = {
    title: htmlToText(title),
    subtitle: htmlToText(first(w.subtitle)),
    authors: people,
    isbn13: isbns.map((i) => normalizeIsbn(i)).find((i): i is string => !!i) ?? null,
    // DOIs are case-insensitive; keep the spelling the book already uses when they match.
    doi: normalizeDoi(w.DOI)?.toLowerCase() === doi.toLowerCase() ? doi : (normalizeDoi(w.DOI) ?? doi),
    publisher: w.publisher?.trim() || null,
    publishedDate: dateFromParts(w.issued?.["date-parts"]) ?? dateFromParts(w.published?.["date-parts"]),
    language: normalizeLanguage(w.language),
    pages: null, // Crossref "page" is a page range, not a count
    description: htmlToText(w.abstract?.replace(/<jats:title>[^<]*<\/jats:title>/gi, "")),
    series: null,
    seriesIndex: null,
    tags: cleanSubjects([...(w.subject ?? []), ...(w.categories ?? [])]),
  };
  const container = first(w["container-title"]);
  const kind = (w.type ?? "").replace(/-/g, " ");
  return {
    source: "doi",
    match,
    id: m.doi!,
    url: `https://doi.org/${m.doi}`,
    label: [via === "crossref" ? "Crossref" : "DOI registry", kind, container, m.publishedDate?.slice(0, 4)].filter(Boolean).join(" · "),
    metadata: m,
    coverUrl: null,
    olEditionKey: null,
    olWorkKey: null,
  };
}

function withMailto(url: string, http: HttpClient): string {
  return http.contact ? `${url}${url.includes("?") ? "&" : "?"}mailto=${encodeURIComponent(http.contact)}` : url;
}

/** All slashes in a DOI suffix may have become `_` in a filename; try those spellings too. */
function doiVariants(doi: string): string[] {
  const i = doi.indexOf("/");
  const suffix = doi.slice(i + 1);
  return suffix.includes("_") ? [doi, `${doi.slice(0, i + 1)}${suffix.replace(/_/g, "/")}`] : [doi];
}

/** Resolve a DOI: Crossref first, then doi.org content negotiation (DataCite, mEDRA, … e.g. arXiv). */
export async function lookupDoi(http: HttpClient, doi: string): Promise<MetadataCandidate | null> {
  for (const variant of doiVariants(doi)) {
    const path = variant.split("/").map(encodeURIComponent).join("/");
    const cr = await http.getJson<{ message?: WorkRecord }>(withMailto(`${CROSSREF}/works/${path}`, http));
    if (cr?.message) {
      const c = toCandidate(cr.message, variant, "crossref", "doi");
      if (c) return c;
    }
    const csl = await http.getJson<WorkRecord>(`https://doi.org/${path}`, CSL_ACCEPT);
    if (csl) {
      const c = toCandidate(csl, variant, "doi.org", "doi");
      if (c) return c;
    }
  }
  return null;
}

/** Crossref bibliographic search (papers, chapters, many books). */
export async function searchCrossref(
  http: HttpClient,
  query: { title?: string | null; author?: string | null; q?: string | null },
  rows = 5,
): Promise<MetadataCandidate[]> {
  const bibliographic = query.q ?? [query.title, query.author].filter(Boolean).join(" ");
  if (!bibliographic.trim()) return [];
  const params = new URLSearchParams({
    "query.bibliographic": bibliographic,
    rows: String(rows),
    select: "DOI,title,subtitle,author,editor,publisher,issued,ISBN,type,container-title,abstract,subject", // "isbn-type" is not selectable here
  });
  const res = await http.getJson<{ message?: { items?: WorkRecord[] } }>(withMailto(`${CROSSREF}/works?${params}`, http));
  return (res?.message?.items ?? [])
    .map((w) => (w.DOI ? toCandidate(w, normalizeDoi(w.DOI) ?? w.DOI, "crossref", "search") : null))
    .filter((c): c is MetadataCandidate => !!c);
}
