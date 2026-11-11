import type { RawMetadata } from "../metadata/types.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { htmlToText, normalizeDate } from "./text.ts";
import { arr, attr, decodeXml, parseXml, textOf } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

/** Read FictionBook XML (plain `.fb2` or zipped `.fb2.zip` / `.fbz`). */
async function readFb2Bytes(path: string): Promise<Uint8Array> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".fb2")) return Bun.file(path).bytes();
  const zip = await ZipArchive.open(path);
  const entry = zip.entries.find((e) => e.name.toLowerCase().endsWith(".fb2")) ?? zip.entries[0];
  if (!entry) throw new Error("Empty FB2 archive");
  return zip.read(entry, 256 * 1024 * 1024);
}

function personName(a: any): string {
  const parts = ["first-name", "middle-name", "last-name"].map((k) => textOf(a?.[k]).trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : textOf(a?.nickname).trim();
}

export async function extractFb2(path: string): Promise<RawMetadata> {
  const xml = decodeXml(await readFb2Bytes(path));
  // Skip parsing the book body; keep the annotation as raw markup (mixed content would lose word order).
  const doc = parseXml(xml, ["FictionBook.body", "*.annotation"])?.FictionBook;
  if (!doc) throw new Error("Not a FictionBook document");
  const ti = doc.description?.["title-info"] ?? {};
  const pi = doc.description?.["publish-info"] ?? {};

  const out: RawMetadata = {};
  out.title = textOf(ti["book-title"]).trim() || undefined;
  out.authors = arr(ti.author).map(personName).filter(Boolean);
  out.tags = arr(ti.genre).map((g) => textOf(g).trim()).filter(Boolean);
  out.description = annotationText(ti.annotation);
  out.language = textOf(ti.lang).trim().toLowerCase() || undefined;
  const seq = arr(ti.sequence)[0] ?? arr(pi.sequence)[0];
  if (seq && attr(seq, "name")) {
    out.series = attr(seq, "name");
    const n = Number(attr(seq, "number"));
    if (Number.isFinite(n) && attr(seq, "number")) out.seriesIndex = n;
  }
  out.publisher = textOf(pi.publisher).trim() || undefined;
  out.publishedDate =
    normalizeDate(textOf(pi.year)) ?? normalizeDate(attr(ti.date, "value") ?? textOf(ti.date)) ?? undefined;
  out.isbn13 = normalizeIsbn(textOf(pi.isbn)) ?? undefined;

  const href = attr(arr(ti.coverpage?.image)[0], "href")?.replace(/^#/, "");
  if (href) {
    const bin = arr(doc.binary).find((b) => attr(b, "id") === href);
    if (bin) {
      out.loadCover = async () =>
        cover(new Uint8Array(Buffer.from(textOf(bin).replace(/\s+/g, ""), "base64")), attr(bin, "content-type") ?? "image/jpeg");
    }
  }
  return out;
}

function annotationText(node: unknown): string | undefined {
  const raw = typeof node === "string" ? node : textOf(node);
  return htmlToText(raw) ?? undefined;
}
