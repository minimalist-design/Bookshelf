import { normalizeDate } from "../extract/text.ts";

/** ISO 639-2 (bibliographic/terminologic) → 639-1 for common languages; others stay as given. */
const ISO_639_2: Record<string, string> = {
  eng: "en", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it", por: "pt", rus: "ru", jpn: "ja",
  chi: "zh", zho: "zh", dut: "nl", nld: "nl", pol: "pl", swe: "sv", nor: "no", dan: "da", fin: "fi", cze: "cs",
  ces: "cs", gre: "el", ell: "el", tur: "tr", ara: "ar", heb: "he", hin: "hi", kor: "ko", lat: "la", hun: "hu",
  rum: "ro", ron: "ro", ukr: "uk", cat: "ca", glg: "gl", baq: "eu", eus: "eu", ice: "is", isl: "is", per: "fa", fas: "fa",
};

/** "eng", "/languages/eng", "en-US", "English" → "en" where known; lowercase otherwise. */
export function normalizeLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/^\/languages\//, "");
  if (!v) return null;
  if (/^[a-z]{2}([-_][a-z0-9]+)?$/.test(v)) return v.slice(0, 2);
  if (ISO_639_2[v]) return ISO_639_2[v];
  const names: Record<string, string> = { english: "en", german: "de", french: "fr", spanish: "es", italian: "it", russian: "ru", portuguese: "pt", japanese: "ja", chinese: "zh", dutch: "nl" };
  return names[v] ?? v;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "June 1990", "Aug 01, 2005", "1987", "2005-08-01" → YYYY[-MM[-DD]]. */
export function parseLooseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = normalizeDate(raw);
  const year = /\b(1[4-9]\d\d|20\d\d)\b/.exec(raw)?.[1];
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}[a-z]*\\.?\\b`, "i").test(raw));
  if (year && month >= 0 && !/^\d{4}-\d{2}/.test(iso ?? "")) {
    const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b(?!\d)/.exec(raw.replace(year, ""))?.[1];
    const mm = String(month + 1).padStart(2, "0");
    return day && Number(day) <= 31 ? `${year}-${mm}-${day.padStart(2, "0")}` : `${year}-${mm}`;
  }
  return iso;
}

/** "date-parts": [[2019, 5, 2]] → "2019-05-02". */
export function dateFromParts(parts: unknown): string | null {
  const p = Array.isArray(parts) && Array.isArray(parts[0]) ? (parts[0] as unknown[]) : null;
  if (!p || typeof p[0] !== "number") return null;
  return normalizeDate(p.filter((x) => typeof x === "number").map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0"))).join("-"));
}

/** "Dune chronicles -- bk. 1", "Foundation ; 2", "Discworld #5", "Saga (Vol. 3)" → name + index. */
export function parseSeries(raw: string | null | undefined): { series: string | null; seriesIndex: number | null } {
  const s = raw?.replace(/\s+/g, " ").trim();
  if (!s) return { series: null, seriesIndex: null };
  const m = /^(.*?)[\s,;:(#-]*(?:\b(?:bk|book|vol|volume|no|nr|part|t|tome)\.?\s*|#\s*|;\s*|,\s*|--\s*)(\d+(?:\.\d+)?)\)?$/i.exec(s);
  if (m && m[1]!.trim()) return { series: m[1]!.replace(/[\s,;:(#-]+$/, "").trim(), seriesIndex: Number(m[2]) };
  return { series: s, seriesIndex: null };
}

const NOISE_SUBJECT = /(new york times|nyt:|accessible book|protected daisy|in library|large type|lending library|overdrive|internet archive|open library|staff picks|reviewed$)/i;

/** Library subject headings → a short list of usable tags. */
export function cleanSubjects(subjects: (string | null | undefined)[], max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subjects) {
    const s = raw?.replace(/\s+/g, " ").trim();
    if (!s || s.length > 48 || NOISE_SUBJECT.test(s) || /[:=]/.test(s)) continue;
    const key = s.toLowerCase().replace(/[,.]+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.replace(/[,.]+$/, ""));
    if (out.length >= max) break;
  }
  return out;
}
