const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML/XHTML fragment → plain text with paragraph breaks preserved. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .split(/\n/)
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s || null;
}

/** Normalize a date-ish string to YYYY, YYYY-MM or YYYY-MM-DD; null for placeholders like 0101-01-01. */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1400 || year > new Date().getFullYear() + 2) return null;
  return [m[1], m[2], m[3]].filter(Boolean).join("-");
}

/** PDF date "D:20100501120000+02'00'" → "2010-05-01". */
export function pdfDate(raw: string | null | undefined): string | null {
  const m = raw ? /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(raw) : null;
  return m ? normalizeDate([m[1], m[2], m[3]].filter(Boolean).join("-")) : null;
}

/** "a, b; c" → ["a", "b", "c"] */
export function splitList(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}
