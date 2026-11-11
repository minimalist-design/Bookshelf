import { XMLParser } from "fast-xml-parser";

/**
 * Namespace prefixes are stripped (`dc:title` → `title`, `opf:scheme` → `@_scheme`).
 * Values stay strings (ISBNs must not become numbers).
 */
export function parseXml(xml: string, stopNodes: string[] = []): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    htmlEntities: true,
    stopNodes,
  });
  return parser.parse(xml);
}

export function arr<T = any>(v: T | T[] | undefined | null): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

/** Text content of a parsed node (string, or object with `#text`), recursively for mixed content. */
export function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(" ");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("#text" in o && Object.keys(o).every((k) => k === "#text" || k.startsWith("@_"))) return textOf(o["#text"]);
    return Object.entries(o)
      .filter(([k]) => !k.startsWith("@_"))
      .map(([, v]) => textOf(v))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

export function attr(node: unknown, name: string): string | undefined {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const v = (node as Record<string, unknown>)[`@_${name}`];
    return v === undefined ? undefined : String(v);
  }
  return undefined;
}

/** Decode the bytes of an XML document honouring its declared encoding (FB2 is often windows-1251). */
export function decodeXml(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const declared = /<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(head)?.[1];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      /* unknown label: fall through to UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
