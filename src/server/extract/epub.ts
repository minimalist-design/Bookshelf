import { posix } from "node:path";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { htmlToText, normalizeDate } from "./text.ts";
import { arr, attr, parseXml, textOf } from "./xml.ts";
import { findEntry, openZip, readEntry, readEntryText } from "./zip.ts";

interface Refinement {
  property: string;
  value: string;
  scheme?: string;
}

/** Extract OPF metadata (EPUB 2 and 3) and locate the cover image. */
export async function extractEpub(path: string): Promise<RawMetadata> {
  const zip = await openZip(path);
  const containerXml = await readEntryText(zip, "META-INF/container.xml");
  if (!containerXml) throw new Error("EPUB without META-INF/container.xml");
  const rootfiles = arr(parseXml(containerXml)?.container?.rootfiles?.rootfile);
  const opfPath = attr(
    rootfiles.find((r) => attr(r, "media-type") === "application/oebps-package+xml") ?? rootfiles[0],
    "full-path",
  );
  if (!opfPath) throw new Error("EPUB container has no rootfile");
  const opfXml = await readEntryText(zip, opfPath);
  if (!opfXml) throw new Error(`EPUB OPF not found: ${opfPath}`);

  const pkg = parseXml(opfXml)?.package ?? {};
  const coverImage = opfCover(pkg, opfPath);
  return {
    ...opfMetadata(pkg),
    ...(coverImage && {
      loadCover: async () => {
        const entry = findEntry(zip, coverImage.path);
        return entry ? cover(await readEntry(zip, entry, 32 * 1024 * 1024)) : null;
      },
    }),
  };
}

/** Lookups over the OPF `<metadata>` block: EPUB 3 refinements and EPUB 2 named metas. */
function opfLookups(md: any) {
  const metas = arr(md.meta);
  // EPUB 3 `<meta refines="#id" property="…">value</meta>`
  const refines = Map.groupBy(
    metas.flatMap((m) => {
      const target = attr(m, "refines");
      const property = attr(m, "property");
      return target && property
        ? [{ id: target.replace(/^#/, ""), property, value: textOf(m).trim(), scheme: attr(m, "scheme") }]
        : [];
    }),
    (r): string => r.id,
  );
  const refined = (node: unknown, property: string): Refinement | undefined => {
    const id = attr(node, "id");
    return id ? refines.get(id)?.find((r) => r.property === property) : undefined;
  };
  const named = (name: string) => attr(metas.find((m) => attr(m, "name") === name), "content");
  return { metas, refined, named };
}

/** Everything but the cover, from a parsed OPF package. */
export function opfMetadata(pkg: any): RawMetadata {
  const md = pkg.metadata ?? {};
  const { metas, refined, named } = opfLookups(md);

  // Titles: EPUB3 may mark main/subtitle via title-type.
  const titles = arr(md.title).map((t) => ({ text: textOf(t).trim(), type: refined(t, "title-type")?.value }));
  const main = titles.find((t) => t.type === "main") ?? titles.find((t) => !t.type) ?? titles[0];

  // Creators with role "aut" (or no role at all).
  const creators = arr(md.creator).filter((c) => {
    const role = attr(c, "role") ?? refined(c, "role")?.value;
    return !role || role === "aut";
  });

  // Identifiers: ISBN / DOI in any of the common spellings; the first usable one of each wins.
  const ids = arr(md.identifier).map((node) => ({
    value: textOf(node).trim(),
    scheme: (attr(node, "scheme") ?? refined(node, "identifier-type")?.value ?? "").toLowerCase(),
  }));
  const isbn13 = ids
    .filter(({ value, scheme }) => scheme.includes("isbn") || /isbn/i.test(value) || /^[\d\s-]{10,17}[\dxX]$/.test(value))
    .map(({ value }) => normalizeIsbn(value))
    .find(Boolean);
  const doi = ids
    .filter(({ value, scheme }) => scheme.includes("doi") || /doi/i.test(value) || value.startsWith("10."))
    .map(({ value }) => normalizeDoi(value))
    .find(Boolean);

  const dates = arr(md.date);
  const pubDate = dates.find((d) => /publication/i.test(attr(d, "event") ?? "")) ?? dates[0];

  return {
    title: main?.text || undefined,
    subtitle: titles.find((t) => t.type === "subtitle")?.text || undefined,
    authors: creators.map((c) => textOf(c).trim() || attr(c, "file-as") || "").filter(Boolean),
    isbn13: isbn13 ?? undefined,
    doi: doi ?? undefined,
    publisher: textOf(arr(md.publisher)[0]).trim() || undefined,
    publishedDate: normalizeDate(textOf(pubDate)) ?? undefined,
    language: textOf(arr(md.language)[0]).trim().toLowerCase() || undefined,
    description: htmlToText(textOf(arr(md.description)[0])) ?? undefined,
    tags: arr(md.subject).map((s) => textOf(s).trim()).filter(Boolean),
    ...opfSeries(metas, refined, named),
  };
}

/** Series: calibre meta or EPUB3 belongs-to-collection (collection-type series). */
function opfSeries(
  metas: readonly unknown[],
  refined: (node: unknown, property: string) => Refinement | undefined,
  named: (name: string) => string | undefined,
): Pick<RawMetadata, "series" | "seriesIndex"> {
  const finite = (n: number) => (Number.isFinite(n) ? n : undefined);
  const calibreSeries = named("calibre:series");
  if (calibreSeries) return { series: calibreSeries, seriesIndex: finite(Number(named("calibre:series_index"))) };
  const coll = metas.find((m) => attr(m, "property") === "belongs-to-collection");
  const type = coll && refined(coll, "collection-type")?.value;
  if (!coll || (type && type !== "series")) return {};
  return { series: textOf(coll).trim() || undefined, seriesIndex: finite(Number(refined(coll, "group-position")?.value)) };
}

/** Cover: EPUB3 cover-image property, EPUB2 <meta name="cover">, or an image item named like a cover. */
function opfCover(pkg: any, opfPath: string): { path: string } | null {
  const items = arr(pkg.manifest?.item);
  const isImage = (it: unknown) => (attr(it, "media-type") ?? "").startsWith("image/");
  const coverId = opfLookups(pkg.metadata ?? {}).named("cover");
  const coverItem =
    items.find((it) => (attr(it, "properties") ?? "").split(/\s+/).includes("cover-image")) ??
    items.find((it) => coverId && attr(it, "id") === coverId && isImage(it)) ??
    items.find((it) => isImage(it) && /cover/i.test(`${attr(it, "id")} ${attr(it, "href")}`));
  const href = attr(coverItem, "href");
  if (!href) return null;
  const opfDir = posix.dirname(opfPath);
  const path = posix.normalize(posix.join(opfDir === "." ? "" : opfDir, safeDecode(href.split("#")[0]!)));
  return { path };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
