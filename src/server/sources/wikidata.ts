import type { AuthorMatchDto } from "../../shared/types.ts";
import { foldKey } from "../cleanup/similarity.ts";
import type { HttpClient } from "./http.ts";

const API = "https://www.wikidata.org/w/api.php";
const SPARQL = "https://query.wikidata.org/sparql";

interface SearchHit {
  id: string;
  label?: string;
  description?: string;
  display?: { label?: { value?: string }; description?: { value?: string } };
  match?: { type?: string; text?: string };
}

interface Binding {
  [name: string]: { value: string } | undefined;
}

/** Library authority records, in the order shown (most authoritative for names first). */
const AUTHORITIES = [
  { prop: "P244", name: "Library of Congress", url: (id: string) => `https://id.loc.gov/authorities/names/${id}.html` },
  { prop: "P227", name: "GND", url: (id: string) => `https://d-nb.info/gnd/${id}` },
  { prop: "P214", name: "VIAF", url: (id: string) => `https://viaf.org/viaf/${id}` },
  { prop: "P648", name: "Open Library", url: (id: string) => `https://openlibrary.org/authors/${id}` },
  { prop: "P496", name: "ORCID", url: (id: string) => `https://orcid.org/${id}` },
] as const;

/**
 * People who write: humans (Q5), and names shared or invented for writing: collective pseudonym
 * (Q16017119, "Nicolas Bourbaki"), house name (Q19913602, "Ellery Queen"), pseudonym (Q61002),
 * pen name (Q127843). Not books, places, bands or fictional characters.
 */
const PERSON_TYPES = ["Q5", "Q16017119", "Q19913602", "Q61002", "Q127843"];

function year(dateTime: string | undefined): string | null {
  const m = /^([+-]?)0*(\d+)-/.exec(dateTime ?? "");
  return m ? `${m[2]}${m[1] === "-" ? " BC" : ""}` : null;
}

/** Only the facts needed to tell authors apart, for the given items that are people. */
function peopleQuery(ids: readonly string[]): string {
  const optional = [
    ["P569", "birth"],
    ["P570", "death"],
    ...AUTHORITIES.map((a) => [a.prop, a.prop]),
  ];
  return `SELECT ?item ${optional.map(([, v]) => `(SAMPLE(?${v}_) AS ?${v})`).join(" ")} WHERE {
  VALUES ?item { ${ids.map((id) => `wd:${id}`).join(" ")} }
  VALUES ?type { ${PERSON_TYPES.map((t) => `wd:${t}`).join(" ")} }
  ?item wdt:P31 ?type .
  ${optional.map(([p, v]) => `OPTIONAL { ?item wdt:${p} ?${v}_ }`).join("\n  ")}
} GROUP BY ?item`;
}

/**
 * People on Wikidata matching a name: display name, years, short description and the library
 * authority records (Library of Congress, GND, VIAF…) that confirm who they are.
 * Order: the exact name first, then names starting with it, then people who only have it as another
 * name (a ghostwriter of "Ellery Queen"); within each, people known to libraries first, then
 * Wikidata's own relevance.
 */
export async function wikidataAuthorSearch(http: HttpClient, q: string, limit = 5): Promise<AuthorMatchDto[]> {
  const params = new URLSearchParams({ action: "wbsearchentities", search: q, language: "en", uselang: "en", type: "item", limit: "15", format: "json" });
  const hits = (await http.getJson<{ search?: SearchHit[] }>(`${API}?${params}`))?.search ?? [];
  if (!hits.length) return [];

  const sparql = await http.getJson<{ results?: { bindings?: Binding[] } }>(
    `${SPARQL}?${new URLSearchParams({ query: peopleQuery(hits.map((h) => h.id)), format: "json" })}`,
    "application/sparql-results+json",
  );
  const people = new Map((sparql?.results?.bindings ?? []).map((b) => [b.item?.value.split("/").at(-1) ?? "", b]));

  return hits
    .filter((h) => people.has(h.id))
    .map((h): AuthorMatchDto => {
      const b = people.get(h.id)!;
      const [born, died] = [year(b.birth?.value), year(b.death?.value)];
      const name = (h.display?.label?.value ?? h.label ?? h.id).replace(/\s+/g, " ").trim();
      return {
        source: "wikidata",
        key: h.id,
        name,
        years: born || died ? `${born ?? "?"}–${died ?? ""}` : null,
        description: h.display?.description?.value ?? h.description ?? null,
        topWork: null,
        workCount: null,
        alternateNames: h.match?.type === "alias" && h.match.text && h.match.text !== name ? [h.match.text] : [],
        authorities: AUTHORITIES.flatMap((a) => {
          const id = b[a.prop]?.value;
          return id ? [{ name: a.name, url: a.url(id) }] : [];
        }),
        url: `https://www.wikidata.org/wiki/${h.id}`,
      };
    })
    .map((m, i) => {
      const byAlias = hits.find((h) => h.id === m.key)?.match?.type === "alias";
      const rank = [foldKey(m.name) === foldKey(q) ? 0 : byAlias ? 2 : 1, m.authorities.length ? 0 : 1, i];
      return { m, rank };
    })
    .toSorted((a, b) => a.rank.reduce((d, x, k) => d || x - b.rank[k]!, 0))
    .map(({ m }) => m)
    .slice(0, limit);
}
