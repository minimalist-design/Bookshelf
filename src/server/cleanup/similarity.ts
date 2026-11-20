/**
 * Finding spelling variants of the same name (an author, tag, series or publisher), so they can be
 * merged. Pure functions: no I/O.
 *
 * Variants are linked by how they differ, strongest first:
 * - `case`: only letter case, accents or spacing ("JANE AUSTEN", "Jane  Austen", "Godel"/"Gödel");
 * - `punctuation`: punctuation or, for authors, name order ("Austen, Jane", "J.R.R. Tolkien");
 * - `typo`: a letter or two off ("Jane Austin");
 * - `initials` (authors only): initials for given names ("J. Austen", "John Ronald Reuel Tolkien").
 */
import type { CleanupField, FacetDto, NameGroupDto, NameMatchKind, NameVariantDto } from "../../shared/types.ts";

/** Letter case, accents and spacing removed. */
export function foldKey(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Case-insensitive dedupe that keeps the first spelling and the order. */
export function dedupeCaseless(list: readonly string[]): string[] {
  return list.filter((x, i) => list.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
}

/** Folded words with punctuation removed; apostrophes join ("O'Brien" = "OBrien"). */
function words(s: string): string[] {
  return foldKey(s)
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const SUFFIX = /^(jr|sr|ii|iii|iv)$/;

/** "Austen, Jane" → "Jane Austen" and "King, Martin Luther, Jr." → "Martin Luther King Jr." (any case); others unchanged. */
export function displayOrder(name: string): string {
  const parts = name.split(",").map((p) => p.trim());
  const suffix = (p: string | undefined) => p !== undefined && SUFFIX.test(words(p).join(" "));
  if (parts.length === 2 && parts[0] && parts[1] && !suffix(parts[1])) return `${parts[1]} ${parts[0]}`;
  if (parts.length === 3 && parts[0] && parts[1] && suffix(parts[2])) return `${parts[1]} ${parts[0]} ${parts[2]}`;
  return name.trim();
}

/** An author's name as given names + surname ("Austen, Jane" and "Jane Austen" alike). */
function nameParts(name: string): { given: string[]; surname: string } {
  const w = words(displayOrder(name)).filter((x) => !SUFFIX.test(x));
  return { given: w.slice(0, -1), surname: w.at(-1) ?? "" };
}

/** Runs of single letters are joined, so "J. R. R.", "J.R.R." and "JRR" agree; real words never absorb them. */
function joinInitials(w: string[]): string[] {
  return w.reduce<{ out: string[]; inRun: boolean }>(
    ({ out, inRun }, x) =>
      x.length !== 1
        ? { out: [...out, x], inRun: false }
        : { out: inRun ? [...out.slice(0, -1), out.at(-1)! + x] : [...out, x], inRun: true },
    { out: [], inRun: false },
  ).out;
}

/** Same for variants that differ only in punctuation or (for authors) name order. */
export function shapeKey(s: string, field: CleanupField): string {
  if (field !== "authors") return words(s).join(" ");
  const { given, surname } = nameParts(s);
  return [...joinInitials(given), surname].sort().join(" ");
}

/** Edit distance with adjacent swaps (optimal string alignment); gives up past `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      row.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** Allowed typos for a key length: none for very short names, then 1, then 2. */
function typoBudget(len: number): number {
  return len < 4 ? 0 : len <= 8 ? 1 : 2;
}

/** Given names that agree once initials are expanded ("J." ↔ "Jane"), with at least one initial involved. */
function initialsMatch(a: string, b: string): boolean {
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (!pa.surname || pa.surname !== pb.surname || !pa.given.length || !pb.given.length) return false;
  const [short, long] = pa.given.length <= pb.given.length ? [pa.given, pb.given] : [pb.given, pa.given];
  const pairs = short.map((x, i) => [x, long[i]!] as const);
  const compatible = pairs.every(([x, y]) => x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y)));
  return compatible && [...short, ...long].some((x) => x.length === 1);
}

/** The strongest way two names are related, or null. */
export function relation(a: string, b: string, field: CleanupField): Exclude<NameMatchKind, "main" | "similar"> | null {
  if (foldKey(a) === foldKey(b)) return "case";
  const ka = shapeKey(a, field);
  const kb = shapeKey(b, field);
  if (ka === kb) return "punctuation";
  const budget = typoBudget(Math.min(ka.length, kb.length));
  if (budget > 0 && editDistance(ka, kb, budget) <= budget) return "typo";
  if (field === "authors" && initialsMatch(a, b)) return "initials";
  return null;
}

const KIND_ORDER: Record<NameMatchKind, number> = { main: 0, case: 1, punctuation: 2, typo: 3, initials: 4, similar: 5 };
const SAFE: ReadonlySet<NameMatchKind> = new Set(["case", "punctuation"]);
const PRESELECTED: ReadonlySet<NameMatchKind> = new Set(["main", ...SAFE]);

/** Single-letter words: "J. R. R. Tolkien" has 3. */
const initialsIn = (name: string) => words(name).filter((w) => w.length === 1).length;

/** Names are only compared within a block: same first two letters of the surname (authors) or name. */
function blockOf(name: string, field: CleanupField): string {
  const key = field === "authors" ? nameParts(name).surname : shapeKey(name, field);
  return key.slice(0, 2);
}

/** All caps or all lowercase reads as badly written; prefer mixed case as a group's main name. */
const wellCased = (s: string) => s !== s.toUpperCase() && s !== s.toLowerCase();

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Group names that look like variants of each other. Each group's main name is its most used
 * spelling; variants are labelled by how they relate to it and sorted strongest first. Groups are
 * sorted the same way (most certain first). Names without variants are returned as `singles`.
 */
export function groupNames(entries: readonly FacetDto[], field: CleanupField): { groups: NameGroupDto[]; singles: FacetDto[] } {
  const names = entries.map((e) => e.name);
  const parent = names.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));

  const blocks = Map.groupBy(
    names.map((_, i) => i),
    (i) => blockOf(names[i]!, field),
  );
  for (const members of blocks.values()) {
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const [i, j] = [members[x]!, members[y]!];
        if (find(i) !== find(j) && relation(names[i]!, names[j]!, field)) parent[find(i)] = find(j);
      }
    }
  }

  const components = [...Map.groupBy(entries, (_, i) => find(i)).values()];
  const groups = components
    .filter((c) => c.length > 1)
    .map((members): NameGroupDto => {
      // How many other spellings differ from a name only in case or punctuation: the group's "centre".
      const safeLinks = new Map(
        members.map((m) => [m, members.filter((o) => o !== m && SAFE.has(relation(m.name, o.name, field) ?? "similar")).length]),
      );
      const main = [...members].sort(
        (a, b) =>
          b.count - a.count ||
          safeLinks.get(b)! - safeLinks.get(a)! ||
          Number(wellCased(b.name)) - Number(wellCased(a.name)) ||
          // "First Last" reads better than "Last, First", and full given names better than initials.
          Number(!b.name.includes(",")) - Number(!a.name.includes(",")) ||
          initialsIn(a.name) - initialsIn(b.name) ||
          collator.compare(a.name, b.name),
      )[0]!;
      const variants = members
        .map((m): NameVariantDto => {
          const match: NameMatchKind = m === main ? "main" : (relation(main.name, m.name, field) ?? "similar");
          return { name: m.name, books: m.count, match, preselected: PRESELECTED.has(match) };
        })
        .sort((a, b) => KIND_ORDER[a.match] - KIND_ORDER[b.match] || b.books - a.books || collator.compare(a.name, b.name));
      return { main: main.name, variants };
    })
    .sort((a, b) => strongest(a) - strongest(b) || collator.compare(a.main, b.main));
  const singles = components
    .filter((c) => c.length === 1)
    .map((c) => c[0]!)
    .sort((a, b) => collator.compare(a.name, b.name));
  return { groups, singles };
}

function strongest(g: NameGroupDto): number {
  return Math.min(...g.variants.filter((v) => v.match !== "main").map((v) => KIND_ORDER[v.match]));
}
