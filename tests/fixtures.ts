// Programmatic generators for tiny but valid book files used by tests.
import { strToU8, zipSync, type Zippable } from "fflate";
import sharp from "sharp";

export async function makePng(width = 60, height = 90, color = { r: 200, g: 40, b: 40 }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: color } })
      .png()
      .toBuffer(),
  );
}

export async function makeJpeg(width = 60, height = 90, color = { r: 40, g: 40, b: 200 }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: color } })
      .jpeg()
      .toBuffer(),
  );
}

// ---- PDF ----------------------------------------------------------------------

/** PDF text string: UTF-16BE hex with BOM, safe for any characters. */
function pdfString(s: string): string {
  let hex = "FEFF";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    for (const u of units) hex += u.toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
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
  };
  for (const [p, data] of Object.entries(files)) zip[opfDir + p] = typeof data === "string" ? strToU8(data) : data;
  return zipSync(zip);
}

// ---- CBZ ----------------------------------------------------------------------

export function makeZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const zip: Zippable = {};
  for (const [p, data] of Object.entries(entries)) zip[p] = typeof data === "string" ? strToU8(data) : data;
  return zipSync(zip);
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
