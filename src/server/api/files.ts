import type { BookFormat } from "../../shared/types.ts";

export const CONTENT_TYPES: Record<BookFormat, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  djvu: "image/vnd.djvu",
};

/** RFC 6266 / 5987: ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

interface ServeOptions {
  contentType: string;
  /** Strong validator; content hashes make perfect ETags. */
  etag: string;
  disposition?: string;
  cacheControl?: string;
}

/** The byte range a single-range `Range` header asks for in a file of `size` bytes; null when it can't be satisfied. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  // "bytes=-N" is a suffix range: the last N bytes.
  const [start, end] = m[1] ? [Number(m[1]), m[2] ? Number(m[2]) : size - 1] : [Math.max(0, size - Number(m[2])), size - 1];
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serve a file with ETag revalidation and single-range requests (pdf.js and media
 * players fetch byte ranges). HEAD returns headers only.
 */
export function serveFile(req: Request, path: string, opts: ServeOptions): Response {
  const file = Bun.file(path);
  const size = file.size;
  const etag = `"${opts.etag}"`;
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Content-Type": opts.contentType,
    "Cache-Control": opts.cacheControl ?? "private, no-cache",
    ...(opts.disposition ? { "Content-Disposition": opts.disposition } : {}),
  };
  const head = req.method === "HEAD";

  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  if (range && (!ifRange || ifRange === etag)) {
    const r = parseRange(range, size);
    if (!r) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    return new Response(head ? null : file.slice(r.start, r.end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${r.start}-${r.end}/${size}`, "Content-Length": String(r.end - r.start + 1) },
    });
  }
  return new Response(head ? null : file, { headers: { ...headers, "Content-Length": String(size) } });
}
