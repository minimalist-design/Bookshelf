import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { run } from "./subprocess.ts";
import { htmlToText, normalizeDate } from "./text.ts";

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

    const out: RawMetadata = { pages: doc.numPages };
    out.title = str(xmp("dc:title")) ?? str(info.Title);
    const xmpCreators = xmp("dc:creator");
    const creators = Array.isArray(xmpCreators) ? xmpCreators.map(str).filter((s): s is string => !!s) : [];
    out.authors = creators.length ? creators : str(info.Author) ? [str(info.Author)!] : [];
    out.description = htmlToText(str(xmp("dc:description"))) ?? undefined;
    out.publisher = str(xmp("dc:publisher"));
    out.language = str(xmp("dc:language"))?.toLowerCase();

    const subject = str(info.Subject);
    const keywords = str(info.Keywords);
    const doiCandidates = [xmp("prism:doi"), xmp("pdfx:doi"), xmp("crossmark:doi"), xmp("dc:identifier"), subject, keywords];
    for (const c of doiCandidates) {
      const s = str(c);
      const doi = s ? normalizeDoi(s) ?? normalizeDoi(DOI_IN_TEXT.exec(s)?.[1]) : null;
      if (doi) {
        out.doi = doi;
        break;
      }
    }
    for (const c of [xmp("prism:isbn"), xmp("dc:identifier"), subject, keywords]) {
      const s = str(c);
      const isbn = s ? normalizeIsbn(s) ?? normalizeIsbn(ISBN_IN_TEXT.exec(s)?.[1]) : null;
      if (isbn) {
        out.isbn13 = isbn;
        break;
      }
    }
    out.publishedDate = normalizeDate(str(xmp("prism:publicationdate")) ?? str(xmp("prism:coverdate"))) ?? undefined;
    if (pdftoppm) out.loadCover = () => renderFirstPage(pdftoppm, path);
    return out;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function renderFirstPage(pdftoppm: string, path: string) {
  // No output root → image on stdout (with -singlefile it would write a file literally named "-.jpg").
  const r = await run([pdftoppm, "-f", "1", "-l", "1", "-jpeg", "-scale-to", "1200", path], 60_000);
  return r.exitCode === 0 ? cover(r.stdout, "image/jpeg") : null;
}
