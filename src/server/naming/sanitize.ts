/**
 * Make a string safe as part of a filename on Linux and portable to SMB/Windows shares.
 * Also neutralizes separators that the filename parsers rely on.
 */
export function sanitizeComponent(input: string, trimTrailingDots = true): string {
  let s = input.normalize("NFC");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/\s*:\s*/g, " - "); // "Title: Subtitle" → "Title - Subtitle"
  s = s.replace(/[\/\\]/g, "_");
  s = s.replace(/"/g, "'");
  s = s.replace(/[<>]/g, "");
  s = s.replace(/[*?]/g, "");
  s = s.replace(/\|/g, "-");
  s = s.replace(/\s+-{2,}\s+/g, " - "); // never emit the import separator " -- "
  s = s.replace(/[\[\]]/g, (c) => (c === "[" ? "(" : ")")); // brackets are reserved for the ID
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+/, ""); // no hidden files
  s = trimTrailingDots ? s.replace(/[.\s]+$/, "") : s.trimEnd(); // no trailing dots/spaces at name end
  return s;
}

/** Author part must not contain " - " (the library-pattern separator). */
export function sanitizeAuthorPart(input: string): string {
  // Not at the end of the filename, so trailing dots ("et al.", "Jr.") are kept.
  return sanitizeComponent(input, false).replace(/\s+-\s+/g, " ");
}

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point, trimming the end. */
export function truncateBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = byteLength(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out.replace(/[\s.,;:-]+$/, "");
}
