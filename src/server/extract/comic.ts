import type { ExternalTools } from "../config.ts";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover, isImageName, mimeFromName, naturalSort } from "./images.ts";
import { run, runText } from "./subprocess.ts";
import { htmlToText, normalizeDate, splitList } from "./text.ts";
import { arr, attr, decodeXml, parseXml, textOf } from "./xml.ts";
import { findEntry, isZipFile, openZip, readEntry } from "./zip.ts";

/** Uniform read access to the entries of a comic archive. */
export interface ComicArchive {
  names: string[];
  read(name: string): Promise<Uint8Array | null>;
}

/** Image entries in reading order (natural sort, hidden/__MACOSX excluded). */
export function comicPages(archive: ComicArchive): string[] {
  return naturalSort(archive.names.filter(isImageName));
}

/** ComicInfo.xml (Anansi schema) → metadata; first page (or FrontCover page) → cover. */
export async function extractComic(archive: ComicArchive): Promise<RawMetadata> {
  const pages = comicPages(archive);
  const infoName = naturalSort(archive.names.filter((n) => /(^|\/)comicinfo\.xml$/i.test(n))).toSorted(
    (a, b) => a.split("/").length - b.split("/").length,
  )[0];
  const bytes = infoName ? await archive.read(infoName) : null;
  const ci = bytes ? parseXml(decodeXml(bytes))?.ComicInfo : null;
  const info = ci ? comicInfo(ci, pages.length) : { meta: {}, frontCoverIndex: null };
  const coverName = pages[info.frontCoverIndex ?? 0];
  return {
    ...info.meta,
    pages: info.meta.pages || pages.length || undefined,
    ...(coverName
      ? {
          loadCover: async () => {
            const data = await archive.read(coverName);
            return data ? cover(data, mimeFromName(coverName)) : null;
          },
        }
      : {}),
  };
}

/** Metadata from a parsed `<ComicInfo>`, and the index of the page it marks as the front cover. */
export function comicInfo(ci: any, pageCount: number): { meta: RawMetadata; frontCoverIndex: number | null } {
  const t = (k: string) => textOf(ci[k]).trim() || undefined;
  const series = t("Series");
  const number = t("Number");
  const idx = Number(number);
  const year = t("Year");
  const mm = t("Month")?.padStart(2, "0");
  const dd = t("Day")?.padStart(2, "0");
  const pageCountField = Number(t("PageCount"));
  const front = arr(ci.Pages?.Page).find((p) => attr(p, "Type") === "FrontCover");
  const image = Number(attr(front, "Image"));
  return {
    meta: {
      title: t("Title") ?? (series ? (number ? `${series} #${number}` : series) : undefined),
      series,
      seriesIndex: series && number && Number.isFinite(idx) ? idx : undefined,
      authors: splitList(t("Writer")),
      publisher: t("Publisher"),
      description: htmlToText(t("Summary")) ?? undefined,
      language: t("LanguageISO")?.toLowerCase(),
      publishedDate: year ? (normalizeDate([year, mm, mm && dd].filter(Boolean).join("-")) ?? undefined) : undefined,
      pages: pageCountField > 0 ? pageCountField : undefined,
      tags: [...splitList(t("Genre")), ...splitList(t("Tags"))],
      isbn13: normalizeIsbn(t("GTIN")) ?? undefined,
    },
    frontCoverIndex: Number.isInteger(image) && image >= 0 && image < pageCount ? image : null,
  };
}

export async function zipComicArchive(path: string): Promise<ComicArchive> {
  const zip = await openZip(path);
  return {
    names: zip.entries.filter((e) => !e.name.endsWith("/")).map((e) => e.name),
    read: async (name) => {
      const e = findEntry(zip, name);
      return e ? readEntry(zip, e, 64 * 1024 * 1024) : null;
    },
  };
}

/** RAR / 7z (and anything else 7-Zip understands) through external tools. */
export async function externalComicArchive(path: string, tools: ExternalTools): Promise<ComicArchive | null> {
  if (tools.sevenZip) {
    const listing = await runText([tools.sevenZip, "l", "-slt", "-ba", "-sccUTF-8", "--", path]);
    if (listing !== null) {
      const exe = tools.sevenZip;
      return {
        names: parseSevenZipListing(listing),
        read: async (name) => {
          // -spd: treat the name literally (no wildcard matching).
          const r = await run([exe, "e", "-so", "-spd", "--", path, name], 60_000);
          return r.exitCode === 0 ? r.stdout : null;
        },
      };
    }
  }
  if (tools.unrar) {
    const listing = await runText([tools.unrar, "lb", "-p-", path]);
    if (listing !== null) {
      const exe = tools.unrar;
      return {
        names: listing.split(/\r?\n/).filter(Boolean),
        read: async (name) => {
          const r = await run([exe, "p", "-inul", "-p-", path, name], 60_000);
          return r.exitCode === 0 ? r.stdout : null;
        },
      };
    }
  }
  return null;
}

/** File paths from `7z l -slt` output (blocks of `Key = value` lines), folders left out. */
export function parseSevenZipListing(listing: string): string[] {
  return listing.split(/\r?\n\r?\n/).flatMap((block) => {
    const p = /^Path = (.*)$/m.exec(block)?.[1];
    const isDir = /^Folder = \+$/m.test(block) || /^Attributes = D/m.test(block);
    return p && !isDir ? [p.replace(/\\/g, "/")] : [];
  });
}

export async function extractCbz(path: string): Promise<RawMetadata> {
  return extractComic(await zipComicArchive(path));
}

/** CBR files are frequently mislabelled ZIPs; those are read natively. */
export async function extractCbr(path: string, tools: ExternalTools): Promise<RawMetadata> {
  if (await isZipFile(path)) return extractCbz(path);
  const archive = await externalComicArchive(path, tools);
  return archive ? extractComic(archive) : {};
}
