/**
 * Wikidata → reference rows: the discovery queries, reading entity JSON (as `wbgetentities` returns it)
 * and turning entities into rows of the reference format. Pure functions; the I/O is in build.ts.
 */
import type { EntityKind } from "../../src/server/reference/format.ts";

/** What an entity is fetched as. Publishers are fetched only for their names. */
export type Role = "person" | "work" | "edition" | "series" | "publisher";
export const ROLES: readonly Role[] = ["person", "work", "edition", "series", "publisher"];

export type Row = Record<string, string | number | null>;
/** Rows by reference table. */
export type Rows = Partial<Record<string, Row[]>>;

// ---------------------------------------------------------------- discovery

export interface Seed {
  name: string;
  role: Role;
  /** SPARQL graph pattern binding ?item. */
  where: string;
}

/** Humans and names used for writing: collective pseudonym, house name, pseudonym, pen name. */
const PERSON_TYPES = ["Q5", "Q16017119", "Q19913602", "Q61002", "Q127843"];
/** writer, novelist, poet, playwright, essayist, author, children's writer, science fiction writer, short story writer. */
const WRITER_OCCUPATIONS = ["Q36180", "Q6625963", "Q49757", "Q214917", "Q11774202", "Q482980", "Q4853732", "Q18844224", "Q15949613"];
/**
 * literary work, book, novel, written work, short story, play, novella, essay, poem, short story collection,
 * poetry collection, epic poem, autobiography, memoir.
 */
const WORK_TYPES = [
  "Q7725634", "Q571", "Q8261", "Q47461344", "Q49084", "Q25379", "Q149537", "Q35760", "Q5185279", "Q1279564", "Q12106333", "Q37484",
  "Q4184", "Q112983",
];
/** version, edition or translation. */
const EDITION_TYPE = "Q3331189";

const values = (v: string, ids: readonly string[]) => `VALUES ?${v} { ${ids.map((id) => `wd:${id}`).join(" ")} }`;

/**
 * Where the build starts. People known to Open Library, people whose occupation is writing, works with an
 * author, editions of a work; everything they refer to (authors of works, editions, series, publishers) is
 * fetched as well.
 */
export const SEEDS: readonly Seed[] = [
  { name: "people-openlibrary", role: "person", where: `${values("type", PERSON_TYPES)} ?item wdt:P31 ?type ; wdt:P648 [] .` },
  { name: "people-writers", role: "person", where: `${values("occupation", WRITER_OCCUPATIONS)} ?item wdt:P106 ?occupation ; wdt:P31 wd:Q5 .` },
  { name: "works", role: "work", where: `${values("type", WORK_TYPES)} ?item wdt:P31 ?type ; wdt:P50 [] .` },
  { name: "editions", role: "edition", where: `?item wdt:P31 wd:${EDITION_TYPE} ; wdt:P629 [] .` },
];

/**
 * One page of a seed. There's no ORDER BY (sorting millions of rows times the query out): the service returns
 * a simple pattern in index order, so pages follow on; an item seen twice is stored once.
 */
export const seedQuery = (seed: Seed, limit: number, offset: number): string =>
  `SELECT ?item WHERE { ${seed.where} } LIMIT ${limit} OFFSET ${offset}`;

/** The item IDs in a SPARQL JSON result. */
export function sparqlItems(json: unknown): string[] {
  const bindings = (json as { results?: { bindings?: { item?: { value?: string } }[] } })?.results?.bindings ?? [];
  return bindings.map((b) => b.item?.value?.split("/").at(-1) ?? "").filter(isItemId);
}

export const isItemId = (s: string): boolean => /^Q\d+$/.test(s);

// ---------------------------------------------------------------- entity JSON

interface Text {
  language: string;
  value: string;
}
interface Snak {
  snaktype?: string;
  datavalue?: { value?: unknown; type?: string };
}
export interface Statement {
  mainsnak?: Snak;
  rank?: "preferred" | "normal" | "deprecated";
  qualifiers?: Record<string, Snak[]>;
}
export interface Entity {
  id: string;
  missing?: string;
  labels?: Record<string, Text>;
  descriptions?: Record<string, Text>;
  aliases?: Record<string, Text[]>;
  claims?: Record<string, Statement[]>;
  sitelinks?: Record<string, unknown>;
  redirects?: { from: string; to: string };
}

/** The entities in a `wbgetentities` response, without the missing ones. */
export function responseEntities(json: unknown): Entity[] {
  const entities = (json as { entities?: Record<string, Entity> })?.entities ?? {};
  return Object.values(entities).filter((e) => e && typeof e.id === "string" && e.missing === undefined);
}

/** Requested IDs answered under another ID (merged items), as from → to. */
export function responseRedirects(json: unknown): [string, string][] {
  const entities = (json as { entities?: Record<string, Entity> })?.entities ?? {};
  return Object.entries(entities).flatMap(([key, e]) =>
    e?.redirects ? [[e.redirects.from, e.redirects.to] as [string, string]] : key !== e?.id && e?.id ? [[key, e.id] as [string, string]] : [],
  );
}

/** A property's statements: deprecated ones dropped, preferred ones first. */
export function statements(e: Entity, prop: string): Statement[] {
  const all = (e.claims?.[prop] ?? []).filter((s) => s.rank !== "deprecated" && s.mainsnak?.snaktype === "value");
  return [...all.filter((s) => s.rank === "preferred"), ...all.filter((s) => s.rank !== "preferred")];
}

const valueOf = (s: Statement | Snak): unknown => ("mainsnak" in s ? s.mainsnak : (s as Snak))?.datavalue?.value;

export const itemIds = (e: Entity, prop: string): string[] =>
  statements(e, prop)
    .map((s) => (valueOf(s) as { id?: string } | undefined)?.id)
    .filter((id): id is string => typeof id === "string" && isItemId(id));

export const strings = (e: Entity, prop: string): string[] =>
  statements(e, prop)
    .map(valueOf)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());

export const monolingual = (e: Entity, prop: string): { text: string; lang: string }[] =>
  statements(e, prop)
    .map((s) => valueOf(s) as { text?: string; language?: string } | undefined)
    .filter((v): v is { text: string; language: string } => typeof v?.text === "string" && v.text.trim() !== "")
    .map((v) => ({ text: v.text.trim(), lang: v.language ?? "" }));

export const quantities = (e: Entity, prop: string): number[] =>
  statements(e, prop)
    .map((s) => Number((valueOf(s) as { amount?: string } | undefined)?.amount))
    .filter((n) => Number.isFinite(n));

export const qualifier = (s: Statement, prop: string): string | null => {
  const v = s.qualifiers?.[prop]?.find((q) => q.snaktype === "value")?.datavalue?.value;
  return typeof v === "string" ? v : null;
};

interface WikidataTime {
  time: string;
  precision: number;
}

/** A Wikidata time as a published date: '1866' (year precision), '1866-01' (month) or '1866-01-14' (day); null if vaguer. */
export function timeToDate(t: WikidataTime): string | null {
  const m = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(t.time);
  if (!m || t.precision < 9) return null;
  const year = `${m[1] === "-" ? "-" : ""}${String(Number(m[2])).padStart(4, "0")}`;
  return t.precision === 9 ? year : t.precision === 10 ? `${year}-${m[3]}` : `${year}-${m[3]}-${m[4]}`;
}

/** A Wikidata time's year (negative before the common era); null when vaguer than a year. */
export function timeToYear(t: WikidataTime): number | null {
  const m = /^([+-])(\d+)-/.exec(t.time);
  return m && t.precision >= 9 ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : null;
}

export const times = (e: Entity, prop: string): WikidataTime[] =>
  statements(e, prop)
    .map((s) => valueOf(s) as WikidataTime | undefined)
    .filter((v): v is WikidataTime => typeof v?.time === "string" && typeof v.precision === "number");

const earliest = (ts: WikidataTime[]): WikidataTime | null =>
  ts.filter((t) => timeToYear(t) !== null).sort((a, b) => timeToYear(a)! - timeToYear(b)!)[0] ?? null;

/** Display name: English, then a name for many languages ('mul'), then the first there is. */
export function pickText(texts: Record<string, Text> | undefined, prefer: readonly string[] = ["en", "mul"]): string | null {
  const all = texts ?? {};
  const found = prefer.map((l) => all[l]?.value).find((v) => v?.trim());
  return (found ?? Object.values(all).find((t) => t.value?.trim())?.value ?? null)?.trim() ?? null;
}

// ---------------------------------------------------------------- references

/** What a role's entities point to, and what those are fetched as. */
const REFERENCES: Record<Role, readonly [string, Role][]> = {
  person: [],
  work: [
    ["P50", "person"], // author
    ["P98", "person"], // editor
    ["P110", "person"], // illustrator
    ["P655", "person"], // translator
    ["P179", "series"], // part of the series
    ["P747", "edition"], // has edition or translation
  ],
  edition: [
    ["P629", "work"], // edition or translation of
    ["P50", "person"],
    ["P98", "person"],
    ["P110", "person"],
    ["P655", "person"],
    ["P123", "publisher"],
    ["P179", "series"],
  ],
  series: [],
  publisher: [],
};

/** The items an entity refers to that the build also needs, with the role to fetch them as. */
export function references(e: Entity, role: Role): { id: string; role: Role }[] {
  return REFERENCES[role].flatMap(([prop, as]) => itemIds(e, prop).map((id) => ({ id, role: as })));
}

// ---------------------------------------------------------------- normalizing

/** Language filter: null keeps every language; names for many languages ('mul') and unknown ones ('') always pass. */
export type Languages = ReadonlySet<string> | null;
const keepLang = (langs: Languages, lang: string) => !langs || lang === "" || lang === "mul" || langs.has(lang);

const IDENTIFIERS: Record<Exclude<EntityKind, "series">, readonly [string, string][]> = {
  author: [
    ["P648", "openlibrary"],
    ["P214", "viaf"],
    ["P244", "loc"],
    ["P227", "gnd"],
    ["P213", "isni"],
    ["P1938", "gutenberg"],
    ["P2963", "goodreads"],
    ["P7400", "librarything"],
    ["P496", "orcid"],
  ],
  work: [
    ["P648", "openlibrary"],
    ["P5331", "oclc"],
    ["P8383", "goodreads"],
    ["P1085", "librarything"],
    ["P2034", "gutenberg"],
    ["P212", "isbn13"],
    ["P957", "isbn10"],
  ],
  edition: [
    ["P212", "isbn13"],
    ["P957", "isbn10"],
    ["P243", "oclc"],
    ["P1144", "lccn"],
    ["P648", "openlibrary"],
    ["P2969", "goodreads"],
    ["P2034", "gutenberg"],
    ["P356", "doi"],
  ],
};

/** An identifier written the way the format compares them; null when it isn't one. */
export function normalizeIdentifier(scheme: string, value: string): string | null {
  const v = value.trim();
  if (scheme === "isbn13") {
    const d = v.replace(/[\s-]/g, "");
    return /^97[89]\d{10}$/.test(d) ? d : null;
  }
  if (scheme === "isbn10") {
    const d = v.replace(/[\s-]/g, "").toUpperCase();
    return /^\d{9}[\dX]$/.test(d) ? d : null;
  }
  if (scheme === "doi") return v.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "") || null;
  if (scheme === "isni") return v.replace(/\s/g, "") || null;
  return v || null;
}

function identifierRows(e: Entity, entity: Exclude<EntityKind, "series">): Row[] {
  const rows = IDENTIFIERS[entity].flatMap(([prop, scheme]) =>
    strings(e, prop).flatMap((raw) => {
      const value = normalizeIdentifier(scheme, raw);
      return value ? [{ entity, entity_id: e.id, scheme, value }] : [];
    }),
  );
  return uniqueRows(rows);
}

const uniqueRows = (rows: Row[]): Row[] => [...new Map(rows.map((r) => [JSON.stringify(r), r])).values()];

/** Every label and alias in the kept languages, as name rows (`kind` 'name' or 'title' for labels). */
function nameRows(e: Entity, langs: Languages, labelKind: string): { name: string; lang: string; kind: string }[] {
  const labels = Object.values(e.labels ?? {}).map((t) => ({ name: t.value.trim(), lang: t.language, kind: labelKind }));
  const aliases = Object.values(e.aliases ?? {})
    .flat()
    .map((t) => ({ name: t.value.trim(), lang: t.language, kind: "alias" }));
  return [...labels, ...aliases].filter((n) => n.name && keepLang(langs, n.lang));
}

const sitelinkCount = (e: Entity): number | null => (e.sitelinks ? Object.keys(e.sitelinks).length : null);

/** Credits (author, editor, illustrator, translator), in the order of the statements, numbered per row. */
function credits(e: Entity): { author_id: string; role: string; position: number }[] {
  const all = (
    [
      ["P50", "author"],
      ["P98", "editor"],
      ["P110", "illustrator"],
      ["P655", "translator"],
    ] as const
  ).flatMap(([prop, role]) => itemIds(e, prop).map((author_id) => ({ author_id, role })));
  const unique = [...new Map(all.map((c) => [`${c.author_id}\u0000${c.role}`, c])).values()];
  return unique.map((c, position) => ({ ...c, position }));
}

export function personRows(e: Entity, langs: Languages): Rows {
  const extra = [
    ...strings(e, "P742").map((name) => ({ name, lang: "", kind: "pseudonym" })),
    ...monolingual(e, "P1477").map((m) => ({ name: m.text, lang: m.lang, kind: "birth_name" })),
    ...monolingual(e, "P1559").map((m) => ({ name: m.text, lang: m.lang, kind: "native" })),
  ].filter((n) => keepLang(langs, n.lang));
  const names = uniqueRows([...nameRows(e, langs, "name"), ...extra].map((n) => ({ author_id: e.id, ...n })));
  const name = pickText(e.labels) ?? (names[0]?.name as string | undefined) ?? null;
  if (!name) return {};
  const birth = earliest(times(e, "P569"));
  const death = earliest(times(e, "P570"));
  return {
    authors: [
      {
        id: e.id,
        name,
        sort_name: null,
        description: pickText(e.descriptions),
        birth_year: birth ? timeToYear(birth) : null,
        death_year: death ? timeToYear(death) : null,
        prominence: sitelinkCount(e),
      },
    ],
    author_names: names,
    identifiers: identifierRows(e, "author"),
  };
}

/** The first series a work or edition is in, with its number when that is one. */
function seriesOf(e: Entity): { series_id: string | null; series_index: number | null } {
  const s = statements(e, "P179").find((st) => (valueOf(st) as { id?: string } | undefined)?.id);
  if (!s) return { series_id: null, series_index: null };
  const ordinal = qualifier(s, "P1545");
  const n = ordinal !== null && /^\d+(\.\d+)?$/.test(ordinal.trim()) ? Number(ordinal) : null;
  return { series_id: (valueOf(s) as { id: string }).id, series_index: n };
}

export function workRows(e: Entity, langs: Languages): Rows {
  const original = monolingual(e, "P1476");
  const titles = uniqueRows(
    [...nameRows(e, langs, "title"), ...original.filter((t) => keepLang(langs, t.lang)).map((t) => ({ name: t.text, lang: t.lang, kind: "original" }))].map(
      (t) => ({ work_id: e.id, title: t.name, lang: t.lang, kind: t.kind }),
    ),
  );
  const title = pickText(e.labels) ?? original[0]?.text ?? null;
  if (!title) return {};
  const first = earliest(times(e, "P577"));
  return {
    works: [
      {
        id: e.id,
        title,
        description: pickText(e.descriptions),
        first_year: first ? timeToYear(first) : null,
        original_lang: original[0]?.lang || null,
        ...seriesOf(e),
        prominence: sitelinkCount(e),
      },
    ],
    work_titles: titles,
    work_authors: credits(e).map((c) => ({ work_id: e.id, ...c })),
    identifiers: identifierRows(e, "work"),
  };
}

/** `publisherName` gives the names of the publishers fetched (an edition names its publisher by item). */
export function editionRows(e: Entity, publisherName: (id: string) => string | null): Rows {
  const title = monolingual(e, "P1476")[0];
  const published = earliest(times(e, "P577"));
  const pages = quantities(e, "P1104")[0];
  const publisher = itemIds(e, "P123").map(publisherName).find((n) => n) ?? null;
  return {
    editions: [
      {
        id: e.id,
        work_id: itemIds(e, "P629")[0] ?? null,
        title: title?.text ?? pickText(e.labels),
        subtitle: monolingual(e, "P1680")[0]?.text ?? null,
        publisher,
        published_date: published ? timeToDate(published) : null,
        year: published ? timeToYear(published) : null,
        lang: title?.lang || null,
        pages: pages !== undefined && pages > 0 ? Math.round(pages) : null,
        binding: null,
        description: null,
      },
    ],
    edition_authors: credits(e).map((c) => ({ edition_id: e.id, ...c })),
    identifiers: identifierRows(e, "edition"),
  };
}

export function seriesRows(e: Entity, langs: Languages): Rows {
  const name = pickText(e.labels);
  if (!name) return {};
  return {
    series: [{ id: e.id, name, description: pickText(e.descriptions) }],
    series_names: uniqueRows(nameRows(e, langs, "name").map((n) => ({ series_id: e.id, ...n }))),
  };
}

/** The reference entity kind a role's rows are, for `record_sources` (publishers make no rows of their own). */
export const ENTITY_OF_ROLE: Record<Role, EntityKind | null> = { person: "author", work: "work", edition: "edition", series: "series", publisher: null };

/** All rows an entity fetched as `role` makes, plus where they came from. */
export function entityRows(e: Entity, role: Role, langs: Languages, publisherName: (id: string) => string | null, responseId: number): Rows {
  const rows =
    role === "person" ? personRows(e, langs) : role === "work" ? workRows(e, langs) : role === "edition" ? editionRows(e, publisherName) : role === "series" ? seriesRows(e, langs) : {};
  const kind = ENTITY_OF_ROLE[role];
  const made = kind && Object.keys(rows).length > 0;
  return made ? { ...rows, record_sources: [{ entity: kind, entity_id: e.id, response_id: responseId }] } : rows;
}

/** Rows of several entities, by table. */
export const mergeRows = (all: Rows[]): Rows =>
  all.reduce<Rows>((acc, r) => {
    for (const [table, rows] of Object.entries(r)) acc[table] = [...(acc[table] ?? []), ...(rows ?? [])];
    return acc;
  }, {});
