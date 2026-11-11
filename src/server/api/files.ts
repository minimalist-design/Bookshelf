import type { BookFormat } from "../../shared/types.ts";

export const CONTENT_TYPES: Record<BookFormat, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  djvu: "image/vnd.djvu",
  fb2: "application/x-fictionbook+xml",
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
  };
  if (opts.disposition) headers["Content-Disposition"] = opts.disposition;
  const head = req.method === "HEAD";

  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] ? Number(m[1]) : NaN;
    let end = m && m[2] ? Number(m[2]) : NaN;
    if (m && !m[1] && m[2]) {
      start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
      end = size - 1;
    } else if (m && m[1] && !m[2]) end = size - 1;
    if (!m || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    const length = end - start + 1;
    return new Response(head ? null : file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(length) },
    });
  }
  return new Response(head ? null : file, { headers: { ...headers, "Content-Length": String(size) } });
}
