const ET_AL = /\s*,?\s+(et\s+al\.?|and\s+others)\s*$/i;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** "Tolkien, J. R. R." → "J. R. R. Tolkien"; names without a comma are returned unchanged. */
export function toDisplayName(name: string): string {
  const n = clean(name);
  const parts = n.split(",").map(clean).filter(Boolean);
  if (parts.length === 2 && isSurname(parts[0]!) && isGivenNames(parts[1]!)) return `${parts[1]} ${parts[0]}`;
  return n;
}

/** Sort key form "Last, First" from a display name. */
export function toSortName(display: string): string {
  const n = clean(display);
  if (n.includes(",")) return n;
  const tokens = n.split(" ");
  if (tokens.length < 2) return n;
  // Keep lowercase particles with the surname: "Ludwig van Beethoven" → "van Beethoven, Ludwig".
  let i = tokens.length - 1;
  while (i > 1 && /^(van|von|der|den|de|del|della|di|da|du|la|le|ter|ten|bin|ibn|al)$/.test(tokens[i - 1]!)) i--;
  const surname = tokens.slice(i).join(" ");
  const given = tokens.slice(0, i).join(" ");
  // Generational suffixes stay at the end: "Martin Luther King Jr." → "King, Martin Luther, Jr."
  if (/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(surname) && i >= 2) {
    return `${tokens[i - 1]}, ${tokens.slice(0, i - 1).join(" ")}, ${surname}`;
  }
  return `${surname}, ${given}`;
}

/** A surname is 1–2 words (allowing particles/hyphens), not initials-only. */
function isSurname(s: string): boolean {
  const words = s.split(" ");
  return words.length <= 2 && !isInitialsOnly(s) && /\p{L}/u.test(s);
}

/** Given names: 1–3 words or initials ("J. R. R.", "Donald E.", "Mary Ann"). */
function isGivenNames(s: string): boolean {
  if (isInitialsOnly(s)) return true;
  const words = s.split(" ");
  return words.length <= 3 && words.every((w) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w));
}

function isInitialsOnly(s: string): boolean {
  return /^(\p{Lu}\.?\s*-?)+$/u.test(s.replace(/\s+/g, ""));
}

/**
 * Split an author string into display names.
 *
 * - `;` separates authors when present (each part may be "Last, First").
 * - Otherwise ` & ` / ` and ` / `,` separate authors.
 * - A string with exactly two comma parts whose first part is a single surname and
 *   second part looks like given names is one author in "Last, First" form.
 * - Trailing "et al." is dropped.
 */
export function splitAuthors(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const input = clean(raw).replace(ET_AL, "");
  if (!input) return [];

  let parts: string[];
  if (input.includes(";")) {
    parts = input.split(";");
  } else {
    const byConj = input.split(/\s+(?:&|and)\s+/i);
    parts = byConj.flatMap((p) => splitCommaList(p));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const name = toDisplayName(p);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function splitCommaList(s: string): string[] {
  const parts = s.split(",").map(clean).filter(Boolean);
  if (parts.length === 2) {
    const [a, b] = parts as [string, string];
    // "Smith, John" or "Le Guin, Ursula K." (multi-word surname only when the given part ends in an initial).
    const aWords = a.split(" ").length;
    const endsWithInitial = /(^|\s)\p{Lu}\.?$/u.test(b);
    if (isSurname(a) && isGivenNames(b) && (aWords === 1 || endsWithInitial)) return [`${a}, ${b}`];
  }
  return parts;
}

/** Author part of a library filename: `A`, `A & B`, `A et al.`, or `Unknown`. */
export function authorsForFilename(authors: readonly string[]): string {
  const names = authors.map(clean).filter(Boolean);
  if (names.length === 0) return "Unknown";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}
