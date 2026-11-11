import type { ExternalTools } from "../config.ts";
import type { RawMetadata } from "../metadata/types.ts";
import type { BookFormat } from "../naming/formats.ts";
import { extractCbr, extractCbz } from "./comic.ts";
import { extractDjvu } from "./djvu.ts";
import { extractEpub } from "./epub.ts";
import { extractFb2 } from "./fb2.ts";
import { extractPdf } from "./pdf.ts";

export type Extractor = (absPath: string, format: BookFormat) => Promise<RawMetadata>;

const TIMEOUT_MS = 60_000;

/**
 * Embedded metadata extraction, dispatched by format. Never throws: a broken,
 * encrypted or unreadable file yields no embedded metadata (the filename is the fallback).
 */
export function createExtractor(tools: ExternalTools): Extractor {
  const byFormat: Record<BookFormat, (path: string) => Promise<RawMetadata>> = {
    epub: extractEpub,
    pdf: (p) => extractPdf(p, tools.pdftoppm),
    cbz: extractCbz,
    cbr: (p) => extractCbr(p, tools),
    djvu: (p) => extractDjvu(p, tools),
    fb2: extractFb2,
  };
  return async (absPath, format) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        byFormat[format](absPath),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.warn(`Could not read embedded metadata from ${absPath}: ${err instanceof Error ? err.message : err}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  };
}
