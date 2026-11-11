/** Strip everything except digits (and a trailing X for ISBN-10). */
function compact(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

export function isValidIsbn13(isbn: string): boolean {
  if (!/^\d{13}$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(isbn[12]);
}

export function isValidIsbn10(isbn: string): boolean {
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (isbn[i] === "X" ? 10 : Number(isbn[i])) * (10 - i);
  return sum % 11 === 0;
}

export function isbn10To13(isbn10: string): string {
  const core = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + ((10 - (sum % 10)) % 10);
}

/**
 * Normalize any ISBN-ish string to ISBN-13 digits.
 * ISBN-13 values are returned even with a bad checksum (the caller decides);
 * ISBN-10 values must be valid to be converted. Returns null when not an ISBN.
 */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = compact(raw.replace(/^\s*(urn:)?isbn[:\s-]*(1[03])?[:\s]*/i, ""));
  if (/^97[89]\d{10}$/.test(c)) return c;
  if (c.length === 10 && isValidIsbn10(c)) return isbn10To13(c);
  return null;
}
