import type { ExternalTools } from "../config.ts";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover, isImageName, mimeFromName, naturalSort } from "./images.ts";
import { run, runText } from "./subprocess.ts";
import { htmlToText, normalizeDate, splitList } from "./text.ts";
import { arr, attr, decodeXml, parseXml, textOf } from "./xml.ts";
import { isZipFile, ZipArchive } from "./zip.ts";

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
  const out: RawMetadata = {};
  const infoName = naturalSort(archive.names.filter((n) => /(^|\/)comicinfo\.xml$/i.test(n))).sort(
    (a, b) => a.split("/").length - b.split("/").length,
  )[0];
  let frontCoverIndex: number | null = null;

  if (infoName) {
    const bytes = await archive.read(infoName);
    const ci = bytes ? parseXml(decodeXml(bytes))?.ComicInfo : null;
    if (ci) {
      const t = (k: string) => textOf(ci[k]).trim() || undefined;
      const series = t("Series");
      const number = t("Number");
      out.title = t("Title") ?? (series ? (number ? `${series} #${number}` : series) : undefined);
      out.series = series;
      const idx = Number(number);
      if (series && number && Number.isFinite(idx)) out.seriesIndex = idx;
      out.authors = splitList(t("Writer"));
      out.publisher = t("Publisher");
      out.description = htmlToText(t("Summary")) ?? undefined;
      out.language = t("LanguageISO")?.toLowerCase();
      const year = t("Year");
      if (year) {
        const mm = t("Month")?.padStart(2, "0");
        const dd = t("Day")?.padStart(2, "0");
        out.publishedDate = normalizeDate([year, mm, mm && dd].filter(Boolean).join("-")) ?? undefined;
      }
      const pageCount = Number(t("PageCount"));
      if (pageCount > 0) out.pages = pageCount;
      out.tags = [...splitList(t("Genre")), ...splitList(t("Tags"))];
      out.isbn13 = normalizeIsbn(t("GTIN")) ?? undefined;
      const front = arr(ci.Pages?.Page).find((p) => attr(p, "Type") === "FrontCover");
      const image = Number(attr(front, "Image"));
      if (Number.isInteger(image) && image >= 0 && image < pages.length) frontCoverIndex = image;
    }
  }
  if (!out.pages && pages.length) out.pages = pages.length;

  const coverName = pages[frontCoverIndex ?? 0];
  if (coverName) {
    out.loadCover = async () => {
      const data = await archive.read(coverName);
      return data ? cover(data, mimeFromName(coverName)) : null;
    };
  }
  return out;
}

export async function zipComicArchive(path: string): Promise<ComicArchive> {
  const zip = await ZipArchive.open(path);
  return {
    names: zip.entries.filter((e) => !e.name.endsWith("/")).map((e) => e.name),
    read: async (name) => {
      const e = zip.find(name);
      return e ? zip.read(e, 64 * 1024 * 1024) : null;
    },
  };
}

/** RAR / 7z (and anything else 7-Zip understands) through external tools. */
export async function externalComicArchive(path: string, tools: ExternalTools): Promise<ComicArchive | null> {
  if (tools.sevenZip) {
    const listing = await runText([tools.sevenZip, "l", "-slt", "-ba", "-sccUTF-8", "--", path]);
    if (listing !== null) {
      const names: string[] = [];
      for (const block of listing.split(/\r?\n\r?\n/)) {
        const p = /^Path = (.*)$/m.exec(block)?.[1];
        const isDir = /^Folder = \+$/m.test(block) || /^Attributes = D/m.test(block);
        if (p && !isDir) names.push(p.replace(/\\/g, "/"));
      }
      const exe = tools.sevenZip;
      return {
        names,
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

export async function extractCbz(path: string): Promise<RawMetadata> {
  return extractComic(await zipComicArchive(path));
}

/** CBR files are frequently mislabelled ZIPs; those are read natively. */
export async function extractCbr(path: string, tools: ExternalTools): Promise<RawMetadata> {
  if (await isZipFile(path)) return extractCbz(path);
  const archive = await externalComicArchive(path, tools);
  return archive ? extractComic(archive) : {};
}
