const JUNK_TITLE: RegExp[] = [
  /^untitled\b/i,
  /^unknown$/i,
  /^microsoft (word|powerpoint|excel)\s*-/i,
  /^document\s*\d*$/i,
  /^(new )?book\s*\d*$/i,
  /\.(docx?|rtf|odt|tex|dvi|indd|qxd|pdf|epub|html?|txt|ps|p65|pm6)$/i,
  /^[0-9a-f]{16,}$/i, // hashes
  /^[\d\s._-]+$/, // only numbers/punctuation
  /^[\w-]+\.(fm|book)$/i,
  /^(title|cover|null|none|n\/a|na)$/i,
];

const JUNK_AUTHOR: RegExp[] = [
  /^(administrator|admin|user|owner|unknown|author|anonymous|default|guest|root|test|null|none|n\/a)$/i,
  /^(user|owner|admin)\d+$/i,
  /^[\d\s._-]+$/,
  /^(calibre|adobe|microsoft|pdftex|latex|acrobat|word)\b/i,
];

/** `fileStem` lets us reject titles that merely echo the filename (common in PDFs). */
export function isJunkTitle(value: string | null | undefined, fileStem?: string): boolean {
  const v = value?.trim();
  if (!v || v.length < 2) return true;
  if (fileStem && v.toLowerCase() === fileStem.trim().toLowerCase()) return true;
  return JUNK_TITLE.some((re) => re.test(v));
}

export function isJunkAuthor(value: string | null | undefined): boolean {
  const v = value?.trim();
  if (!v || v.length < 2) return true;
  return JUNK_AUTHOR.some((re) => re.test(v));
}
