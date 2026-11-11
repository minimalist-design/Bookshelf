import sharp from "sharp";
import type { ExternalTools } from "../config.ts";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { run, runText } from "./subprocess.ts";
import { normalizeDate } from "./text.ts";

/** Parse `djvused -u -e print-meta` output: `key<TAB>"value"` lines with C-style escapes. */
export function parseDjvuMeta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (!m) continue;
    out[m[1]!.toLowerCase()] = m[2]!.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t" })[c] ?? c);
  }
  return out;
}

export async function extractDjvu(path: string, tools: ExternalTools): Promise<RawMetadata> {
  const out: RawMetadata = {};
  if (tools.djvused) {
    const meta = parseDjvuMeta((await runText([tools.djvused, "-u", path, "-e", "print-meta"])) ?? "");
    out.title = meta.title;
    out.authors = meta.author ? [meta.author] : [];
    out.publisher = meta.publisher;
    out.publishedDate = normalizeDate(meta.year ?? meta.date) ?? undefined;
    out.isbn13 = normalizeIsbn(meta.isbn) ?? undefined;
    out.doi = normalizeDoi(meta.doi) ?? undefined;
    out.description = meta.subject ?? meta.note;
    const pages = Number((await runText([tools.djvused, path, "-e", "n"]))?.trim());
    if (pages > 0) out.pages = pages;
  }
  if (tools.ddjvu) {
    const ddjvu = tools.ddjvu;
    out.loadCover = async () => {
      const r = await run([ddjvu, "-format=ppm", "-page=1", "-size=1200x1800", path, "-"], 60_000);
      if (r.exitCode !== 0) return null;
      const jpeg = await ppmToJpeg(r.stdout);
      return jpeg ? cover(jpeg, "image/jpeg") : null;
    };
  }
  return out;
}

/** Binary PPM (P6, 8-bit) → JPEG via sharp's raw input. */
export async function ppmToJpeg(ppm: Uint8Array): Promise<Uint8Array | null> {
  const header = new TextDecoder("latin1").decode(ppm.subarray(0, 64));
  const m = /^P6\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(header);
  if (!m || Number(m[3]) !== 255) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const pixels = ppm.subarray(m[0].length, m[0].length + width * height * 3);
  if (pixels.length !== width * height * 3) return null;
  return new Uint8Array(await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer());
}
