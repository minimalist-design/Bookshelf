import type { RawMetadata } from "../metadata/types.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { htmlToText, normalizeDate } from "./text.ts";
import { arr, attr, decodeXml, parseXml, textOf } from "./xml.ts";
import { openZip, readEntry } from "./zip.ts";

/** Read FictionBook XML (plain `.fb2` or zipped `.fb2.zip` / `.fbz`). */
async function readFb2Bytes(path: string): Promise<Uint8Array> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".fb2")) return Bun.file(path).bytes();
  const zip = await openZip(path);
  const entry = zip.entries.find((e) => e.name.toLowerCase().endsWith(".fb2")) ?? zip.entries[0];
  if (!entry) throw new Error("Empty FB2 archive");
  return readEntry(zip, entry, 256 * 1024 * 1024);
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

  const seq = arr(ti.sequence)[0] ?? arr(pi.sequence)[0];
  const seriesName = seq ? attr(seq, "name") : undefined;
  const number = seriesName ? attr(seq, "number") : undefined;
  const href = attr(arr(ti.coverpage?.image)[0], "href")?.replace(/^#/, "");
  const bin = href ? arr(doc.binary).find((b) => attr(b, "id") === href) : undefined;
  return {
    title: textOf(ti["book-title"]).trim() || undefined,
    authors: arr(ti.author).map(personName).filter(Boolean),
    tags: arr(ti.genre).map((g) => textOf(g).trim()).filter(Boolean),
    description: annotationText(ti.annotation),
    language: textOf(ti.lang).trim().toLowerCase() || undefined,
    series: seriesName,
    seriesIndex: number && Number.isFinite(Number(number)) ? Number(number) : undefined,
    publisher: textOf(pi.publisher).trim() || undefined,
    publishedDate: normalizeDate(textOf(pi.year)) ?? normalizeDate(attr(ti.date, "value") ?? textOf(ti.date)) ?? undefined,
    isbn13: normalizeIsbn(textOf(pi.isbn)) ?? undefined,
    ...(bin
      ? {
          loadCover: async () =>
            cover(new Uint8Array(Buffer.from(textOf(bin).replace(/\s+/g, ""), "base64")), attr(bin, "content-type") ?? "image/jpeg"),
        }
      : {}),
  };
}

function annotationText(node: unknown): string | undefined {
  const raw = typeof node === "string" ? node : textOf(node);
  return htmlToText(raw) ?? undefined;
}
