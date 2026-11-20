// Must stay the first import: it silences pdf.js's canvas polyfill warnings while pdf.js loads.
import { restoreConsoleWarn } from "./pdfjsNodeWarnings.ts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-expect-error -- the worker module ships without type declarations
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { run } from "./subprocess.ts";
import { htmlToText, normalizeDate } from "./text.ts";

// Every import has been evaluated by now, pdf.js included: later warnings go through unfiltered.
restoreConsoleWarn();

// Outside a browser pdf.js runs its worker in-process, loading it with a runtime `import("./pdf.worker.mjs")`
// unless the module is already registered here. Registering it statically lets the bundler include it, which the
// compiled single-file binary needs.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"<>,;]+)/;
const ISBN_IN_TEXT = /\bISBN(?:-1[03])?:?\s*((?:97[89][\s-]?)?\d[\d\s-]{8,14}[\dXx])\b/i;

interface PdfInfo {
  Title?: unknown;
  Author?: unknown;
  Subject?: unknown;
  Keywords?: unknown;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ") || undefined;
  return undefined;
}

/** The first value that `parse` accepts. */
function firstParsed(candidates: readonly unknown[], parse: (s: string) => string | null): string | undefined {
  return candidates
    .map(str)
    .map((s) => (s ? parse(s) : null))
    .find((v): v is string => !!v);
}

/** Info dictionary and XMP values (looked up through `xmp`) → metadata. */
export function pdfInfoToRaw(info: PdfInfo, xmp: (key: string) => unknown, pages: number): RawMetadata {
  const xmpCreators = xmp("dc:creator");
  const creators = Array.isArray(xmpCreators) ? xmpCreators.map(str).filter((s): s is string => !!s) : [];
  const infoAuthor = str(info.Author);
  const subject = str(info.Subject);
  const keywords = str(info.Keywords);
  return {
    pages,
    title: str(xmp("dc:title")) ?? str(info.Title),
    authors: creators.length ? creators : infoAuthor ? [infoAuthor] : [],
    description: htmlToText(str(xmp("dc:description"))) ?? undefined,
    publisher: str(xmp("dc:publisher")),
    language: str(xmp("dc:language"))?.toLowerCase(),
    doi: firstParsed(
      [xmp("prism:doi"), xmp("pdfx:doi"), xmp("crossmark:doi"), xmp("dc:identifier"), subject, keywords],
      (s) => normalizeDoi(s) ?? normalizeDoi(DOI_IN_TEXT.exec(s)?.[1]),
    ),
    isbn13: firstParsed(
      [xmp("prism:isbn"), xmp("dc:identifier"), subject, keywords],
      (s) => normalizeIsbn(s) ?? normalizeIsbn(ISBN_IN_TEXT.exec(s)?.[1]),
    ),
    publishedDate: normalizeDate(str(xmp("prism:publicationdate")) ?? str(xmp("prism:coverdate"))) ?? undefined,
  };
}

/**
 * Reads the Info dictionary and XMP packet without loading the whole file:
 * pdf.js fetches only the byte ranges it needs through a range transport.
 */
export async function extractPdf(path: string, pdftoppm: string | null): Promise<RawMetadata> {
  const file = Bun.file(path);
  const transport = new pdfjs.PDFDataRangeTransport(file.size, null);
  transport.requestDataRange = (begin: number, end: number) => {
    file
      .slice(begin, end)
      .bytes()
      .then((chunk) => transport.onDataRange(begin, chunk))
      .catch(() => transport.abort());
  };
  const task = pdfjs.getDocument({
    range: transport,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  } as Parameters<typeof pdfjs.getDocument>[0]);

  try {
    const doc = await task.promise;
    const { info, metadata } = (await doc.getMetadata()) as { info: PdfInfo; metadata: { get(k: string): unknown } | null };
    const xmp = (k: string) => (metadata ? metadata.get(k) : undefined);
    return {
      ...pdfInfoToRaw(info, xmp, doc.numPages),
      ...(pdftoppm ? { loadCover: () => renderFirstPage(pdftoppm, path) } : {}),
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function renderFirstPage(pdftoppm: string, path: string) {
  // No output root → image on stdout (with -singlefile it would write a file literally named "-.jpg").
  const r = await run([pdftoppm, "-f", "1", "-l", "1", "-jpeg", "-scale-to", "1200", path], 60_000);
  return r.exitCode === 0 ? cover(r.stdout, "image/jpeg") : null;
}
