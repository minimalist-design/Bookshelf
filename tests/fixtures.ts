// Test setup (scratch directories, apps on them) and generators for tiny but valid book files.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync, type Zippable } from "fflate";
import { createApp, type AppContext, type CreateAppOptions } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import type { ConfigFileSettings } from "../src/server/configFile.ts";
import { rgbToBmp } from "../src/server/covers/raster.ts";

// ---- apps ---------------------------------------------------------------------------

/** Library timings short enough for tests: the watcher reacts in about a tenth of a second. */
export const FAST_LIBRARY = { debounceMs: 30, stableMs: 80, graceMs: 300 } as const;
/** The same, but metadata of vanished files is kept while a test looks at it. */
export const SLOW_RETENTION = { ...FAST_LIBRARY, graceMs: 60_000 } as const;

/** A scratch directory holding `library/` (with the given shelves) and, once an app runs on it, `data/`. */
export function scratchDir(name: string, shelves: readonly string[] = []): { tmp: string; root: string } {
  const tmp = mkdtempSync(join(tmpdir(), `bookshelf-${name}-`));
  const root = join(tmp, "library");
  for (const dir of [root, ...shelves.map((s) => join(root, s))]) mkdirSync(dir, { recursive: true });
  return { tmp, root };
}

/** An app with its data in `<tmp>/data`, fast library timings unless `options.library` says otherwise. */
export function testApp(
  tmp: string,
  settings: ConfigFileSettings = {},
  options: CreateAppOptions = {},
  env?: Record<string, string | undefined>,
): AppContext {
  return createApp(loadConfig({ data_dir: join(tmp, "data"), ...settings }, env), { ...options, library: { ...FAST_LIBRARY, ...options.library } });
}

/** Stop the app's background work and close it, then remove the scratch directory. */
export async function closeTestApp(app: AppContext | undefined, tmp?: string): Promise<void> {
  if (app) {
    app.lookup.stop();
    await app.lookup.idle();
    app.isbndbCovers.stop();
    await app.isbndbCovers.idle();
    await app.library.close();
    app.db.close();
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

// ---- book files -----------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number };

/** Solid-colour image as BMP, which Bun.Image can re-encode. */
function solid(width: number, height: number, { r, g, b }: Rgb): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) rgb.set([r, g, b], i);
  return rgbToBmp(rgb, width, height);
}

export async function makePng(width = 60, height = 90, color: Rgb = { r: 200, g: 40, b: 40 }): Promise<Uint8Array> {
  return new Bun.Image(solid(width, height, color)).png().bytes();
}

export async function makeJpeg(width = 60, height = 90, color: Rgb = { r: 40, g: 40, b: 200 }): Promise<Uint8Array> {
  return new Bun.Image(solid(width, height, color)).jpeg().bytes();
}

// ---- PDF ----------------------------------------------------------------------

/** PDF text string: UTF-16BE hex with BOM, safe for any characters. */
function pdfString(s: string): string {
  const units = [...s].flatMap((ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
  });
  return `<FEFF${units.map((u) => u.toString(16).padStart(4, "0").toUpperCase()).join("")}>`;
}

export interface PdfOptions {
  info?: Record<string, string>;
  xmp?: string;
  pages?: number;
}

export function xmpPacket(dc: { title?: string; creators?: string[]; doi?: string; subjects?: string[] }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
   ${dc.title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(dc.title)}</rdf:li></rdf:Alt></dc:title>` : ""}
   ${dc.creators ? `<dc:creator><rdf:Seq>${dc.creators.map((c) => `<rdf:li>${esc(c)}</rdf:li>`).join("")}</rdf:Seq></dc:creator>` : ""}
   ${dc.subjects ? `<dc:subject><rdf:Bag>${dc.subjects.map((c) => `<rdf:li>${esc(c)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>` : ""}
   ${dc.doi ? `<prism:doi>${esc(dc.doi)}</prism:doi>` : ""}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** A structurally valid PDF with an Info dictionary, optional XMP and N coloured pages. */
export function makePdf({ info = {}, xmp, pages = 1 }: PdfOptions = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };
  const enc = new TextEncoder();
  const stream = (dict: string, data: string) => `<< ${dict} /Length ${enc.encode(data).length} >>\nstream\n${data}\nendstream`;

  const catalog = add(""); // placeholder, filled below
  const pagesObj = add("");
  const kids: number[] = [];
  for (let i = 0; i < pages; i++) {
    const content = add(stream("", `0.${(i % 9) + 1} 0.4 0.8 rg 20 20 160 260 re f`));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 200 300] /Contents ${content} 0 R >>`));
  }
  const metadata = xmp ? add(stream("/Type /Metadata /Subtype /XML", xmp)) : null;
  const infoObj = add(`<< ${Object.entries(info).map(([k, v]) => `/${k} ${pdfString(v)}`).join(" ")} >>`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${metadata ? ` /Metadata ${metadata} 0 R` : ""} >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`;

  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(enc.encode(out).length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = enc.encode(out).length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

// ---- EPUB ---------------------------------------------------------------------

export interface EpubOptions {
  metadataXml: string; // inner XML of <metadata>
  manifestXml?: string; // extra <item> elements
  version?: "2.0" | "3.0";
  opfPath?: string;
  files?: Record<string, Uint8Array | string>; // paths relative to the OPF directory
}

export function makeEpub({ metadataXml, manifestXml = "", version = "3.0", opfPath = "OEBPS/content.opf", files = {} }: EpubOptions): Uint8Array {
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ${metadataXml}
  </metadata>
  <manifest>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
    ${manifestXml}
  </manifest>
  <spine><itemref idref="text"/></spine>
</package>`;
  const zip: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    [opfPath]: strToU8(opf),
    [`${opfDir}text.xhtml`]: strToU8("<html xmlns='http://www.w3.org/1999/xhtml'><body><p>Hi</p></body></html>"),
    ...zippable(files, opfDir),
  };
  return zipSync(zip);
}

// ---- CBZ ----------------------------------------------------------------------

/** Archive entries as bytes, their paths under `prefix`. */
const zippable = (entries: Record<string, Uint8Array | string>, prefix = ""): Zippable =>
  Object.fromEntries(Object.entries(entries).map(([p, data]) => [prefix + p, typeof data === "string" ? strToU8(data) : data]));

export function makeZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  return zipSync(zippable(entries));
}

// ---- FB2 ----------------------------------------------------------------------

export function makeFb2(opts: { titleInfo: string; publishInfo?: string; coverPng?: Uint8Array }): string {
  const cover = opts.coverPng
    ? `<binary id="cover.png" content-type="image/png">${Buffer.from(opts.coverPng).toString("base64")}</binary>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      ${opts.titleInfo}
      ${opts.coverPng ? '<coverpage><image l:href="#cover.png"/></coverpage>' : ""}
    </title-info>
    ${opts.publishInfo ? `<publish-info>${opts.publishInfo}</publish-info>` : ""}
  </description>
  <body><section><p>Text</p></section></body>
  ${cover}
</FictionBook>`;
}
