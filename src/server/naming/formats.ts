export const FORMATS = ["epub", "pdf", "cbz", "cbr", "djvu"] as const;
export type BookFormat = (typeof FORMATS)[number];

/** Recognized extensions (lowercase). */
const EXTENSIONS: readonly [string, BookFormat][] = [
  [".epub", "epub"],
  [".pdf", "pdf"],
  [".cbz", "cbz"],
  [".cbr", "cbr"],
  [".djvu", "djvu"],
  [".djv", "djvu"],
];

export interface DetectedFormat {
  readonly format: BookFormat;
  /** Extension exactly as it appears in the filename (original case), including the leading dot. */
  readonly ext: string;
  /** Filename without the extension. */
  readonly stem: string;
}

/** Identify a supported book file by its name; null when unsupported. */
export function detectFormat(filename: string): DetectedFormat | null {
  const lower = filename.toLowerCase();
  const match = EXTENSIONS.find(([ext]) => lower.endsWith(ext) && lower.length > ext.length);
  if (!match) return null;
  const [ext, format] = match;
  const cut = filename.length - ext.length;
  return { format, ext: filename.slice(cut), stem: filename.slice(0, cut) };
}
