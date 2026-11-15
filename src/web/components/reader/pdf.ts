import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/types/src/display/api";
import { fileUrl } from "./fileUrls.ts";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs";

/** Open a book's PDF with pdf.js, fetching only the byte ranges of the pages actually rendered. */
export function openPdf(bookId: number, hash: string): PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    url: fileUrl(bookId, hash),
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    // Decoders for JBIG2 / JPEG 2000 images (most scanned PDFs) and CMYK colour; without them those pages render blank.
    wasmUrl: "/vendor/pdfjs/wasm/",
    iccUrl: "/vendor/pdfjs/iccs/",
    disableAutoFetch: true,
    rangeChunkSize: 256 * 1024,
  });
}
