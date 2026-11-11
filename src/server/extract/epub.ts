import { posix } from "node:path";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover, mimeFromName } from "./images.ts";
import { htmlToText, normalizeDate } from "./text.ts";
import { arr, attr, parseXml, textOf } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

interface Refinement {
  property: string;
  value: string;
  scheme?: string;
}

/** Extract OPF metadata (EPUB 2 and 3) and locate the cover image. */
export async function extractEpub(path: string): Promise<RawMetadata> {
  const zip = await ZipArchive.open(path);
  const containerXml = await zip.readText("META-INF/container.xml");
  if (!containerXml) throw new Error("EPUB without META-INF/container.xml");
  const rootfiles = arr(parseXml(containerXml)?.container?.rootfiles?.rootfile);
  const opfPath = attr(
    rootfiles.find((r) => attr(r, "media-type") === "application/oebps-package+xml") ?? rootfiles[0],
    "full-path",
  );
  if (!opfPath) throw new Error("EPUB container has no rootfile");
  const opfXml = await zip.readText(opfPath);
  if (!opfXml) throw new Error(`EPUB OPF not found: ${opfPath}`);

  const pkg = parseXml(opfXml)?.package ?? {};
  const md = pkg.metadata ?? {};
  const metas = arr(md.meta);

  // EPUB 3 `<meta refines="#id" property="…">value</meta>`
  const refines = new Map<string, Refinement[]>();
  for (const m of metas) {
    const target = attr(m, "refines");
    const property = attr(m, "property");
    if (!target || !property) continue;
    const id = target.replace(/^#/, "");
    const list = refines.get(id) ?? [];
    list.push({ property, value: textOf(m).trim(), scheme: attr(m, "scheme") });
    refines.set(id, list);
  }
  const refined = (node: unknown, property: string) => {
    const id = attr(node, "id");
    return id ? refines.get(id)?.find((r) => r.property === property) : undefined;
  };
  const named = (name: string) => attr(metas.find((m) => attr(m, "name") === name), "content");

  const out: RawMetadata = {};

  // Titles: EPUB3 may mark main/subtitle via title-type.
  const titles = arr(md.title).map((t) => ({ text: textOf(t).trim(), type: refined(t, "title-type")?.value }));
  const main = titles.find((t) => t.type === "main") ?? titles.find((t) => !t.type) ?? titles[0];
  out.title = main?.text || undefined;
  out.subtitle = titles.find((t) => t.type === "subtitle")?.text || undefined;

  // Creators with role "aut" (or no role at all).
  const creators = arr(md.creator).filter((c) => {
    const role = attr(c, "role") ?? refined(c, "role")?.value;
    return !role || role === "aut";
  });
  out.authors = creators.map((c) => textOf(c).trim() || attr(c, "file-as") || "").filter(Boolean);

  // Identifiers: ISBN / DOI in any of the common spellings.
  for (const idNode of arr(md.identifier)) {
    const value = textOf(idNode).trim();
    const scheme = (attr(idNode, "scheme") ?? refined(idNode, "identifier-type")?.value ?? "").toLowerCase();
    if (!out.isbn13 && (scheme.includes("isbn") || /isbn/i.test(value) || /^[\d\s-]{10,17}[\dxX]$/.test(value))) {
      out.isbn13 = normalizeIsbn(value) ?? undefined;
    }
    if (!out.doi && (scheme.includes("doi") || /doi/i.test(value) || value.startsWith("10."))) {
      out.doi = normalizeDoi(value) ?? undefined;
    }
  }

  out.publisher = textOf(arr(md.publisher)[0]).trim() || undefined;
  const dates = arr(md.date);
  const pubDate = dates.find((d) => /publication/i.test(attr(d, "event") ?? "")) ?? dates[0];
  out.publishedDate = normalizeDate(textOf(pubDate)) ?? undefined;
  out.language = textOf(arr(md.language)[0]).trim().toLowerCase() || undefined;
  out.description = htmlToText(textOf(arr(md.description)[0])) ?? undefined;
  out.tags = arr(md.subject).map((s) => textOf(s).trim()).filter(Boolean);

  // Series: calibre meta or EPUB3 belongs-to-collection (collection-type series).
  const calibreSeries = named("calibre:series");
  if (calibreSeries) {
    out.series = calibreSeries;
    const idx = Number(named("calibre:series_index"));
    if (Number.isFinite(idx)) out.seriesIndex = idx;
  } else {
    const coll = metas.find((m) => attr(m, "property") === "belongs-to-collection");
    if (coll) {
      const type = refined(coll, "collection-type")?.value;
      if (!type || type === "series") {
        out.series = textOf(coll).trim() || undefined;
        const pos = Number(refined(coll, "group-position")?.value);
        if (Number.isFinite(pos)) out.seriesIndex = pos;
      }
    }
  }

  // Cover: EPUB3 cover-image property, EPUB2 <meta name="cover">, or an image item named like a cover.
  const items = arr(pkg.manifest?.item);
  const isImage = (it: unknown) => (attr(it, "media-type") ?? "").startsWith("image/");
  const coverId = named("cover");
  const coverItem =
    items.find((it) => (attr(it, "properties") ?? "").split(/\s+/).includes("cover-image")) ??
    items.find((it) => coverId && attr(it, "id") === coverId && isImage(it)) ??
    items.find((it) => isImage(it) && /cover/i.test(`${attr(it, "id")} ${attr(it, "href")}`));
  const href = attr(coverItem, "href");
  if (href) {
    const opfDir = posix.dirname(opfPath);
    const coverPath = posix.normalize(posix.join(opfDir === "." ? "" : opfDir, safeDecode(href.split("#")[0]!)));
    out.loadCover = async () => {
      const entry = zip.find(coverPath);
      return entry ? cover(await zip.read(entry, 32 * 1024 * 1024), attr(coverItem, "media-type") ?? mimeFromName(coverPath)) : null;
    };
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
