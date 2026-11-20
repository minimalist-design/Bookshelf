export const FORMATS = ["epub", "pdf", "cbz", "cbr", "djvu", "fb2"] as const;
export type BookFormat = (typeof FORMATS)[number];

/** Recognized extensions (lowercase, longest first so `.fb2.zip` wins over `.zip`). */
const EXTENSIONS: readonly [string, BookFormat][] = [
  [".fb2.zip", "fb2"],
  [".epub", "epub"],
  [".pdf", "pdf"],
  [".cbz", "cbz"],
  [".cbr", "cbr"],
  [".djvu", "djvu"],
  [".djv", "djvu"],
  [".fb2", "fb2"],
  [".fbz", "fb2"],
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
