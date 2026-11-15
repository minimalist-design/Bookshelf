/** Display form of an edition statement: a bare number becomes "2nd edition"; anything else is shown as entered. */
export function formatEdition(edition: string): string {
  const s = edition.trim();
  if (!/^\d+$/.test(s)) return s;
  const n = Number(s);
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix} edition`;
}
