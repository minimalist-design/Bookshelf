import type { ExternalTools } from "../config.ts";
import { rgbToBmp } from "../covers/raster.ts";
import type { RawMetadata } from "../metadata/types.ts";
import { normalizeDoi } from "../naming/doi.ts";
import { normalizeIsbn } from "../naming/isbn.ts";
import { cover } from "./images.ts";
import { run, runText } from "./subprocess.ts";
import { normalizeDate } from "./text.ts";

/** Parse `djvused -u -e print-meta` output: `key<TAB>"value"` lines with C-style escapes. */
export function parseDjvuMeta(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split(/\r?\n/).flatMap((line) => {
      const m = /^(\S+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
      return m ? [[m[1]!.toLowerCase(), m[2]!.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t" })[c] ?? c)]] : [];
    }),
  );
}

/** DjVu metadata keys and the page count → metadata. */
export function djvuMetaToRaw(meta: Record<string, string>, pages: number): RawMetadata {
  return {
    title: meta.title,
    authors: meta.author ? [meta.author] : [],
    publisher: meta.publisher,
    publishedDate: normalizeDate(meta.year ?? meta.date) ?? undefined,
    isbn13: normalizeIsbn(meta.isbn) ?? undefined,
    doi: normalizeDoi(meta.doi) ?? undefined,
    description: meta.subject ?? meta.note,
    pages: pages > 0 ? pages : undefined,
  };
}

async function readDjvused(djvused: string, path: string): Promise<RawMetadata> {
  const meta = parseDjvuMeta((await runText([djvused, "-u", path, "-e", "print-meta"])) ?? "");
  const pages = Number((await runText([djvused, path, "-e", "n"]))?.trim());
  return djvuMetaToRaw(meta, pages);
}

export async function extractDjvu(path: string, tools: ExternalTools): Promise<RawMetadata> {
  const ddjvu = tools.ddjvu;
  return {
    ...(tools.djvused ? await readDjvused(tools.djvused, path) : {}),
    ...(ddjvu
      ? {
          loadCover: async () => {
            const r = await run([ddjvu, "-format=ppm", "-page=1", "-size=1200x1800", path, "-"], 60_000);
            if (r.exitCode !== 0) return null;
            const jpeg = await ppmToJpeg(r.stdout);
            return jpeg ? cover(jpeg) : null;
          },
        }
      : {}),
  };
}

/** Binary PPM (P6, 8-bit) → JPEG (wrapped as BMP, which Bun.Image decodes). */
export async function ppmToJpeg(ppm: Uint8Array): Promise<Uint8Array | null> {
  const header = new TextDecoder("latin1").decode(ppm.subarray(0, 64));
  const m = /^P6\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(header);
  if (!m || Number(m[3]) !== 255) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const pixels = ppm.subarray(m[0].length, m[0].length + width * height * 3);
  if (pixels.length !== width * height * 3) return null;
  return new Bun.Image(rgbToBmp(pixels, width, height)).jpeg({ quality: 88 }).bytes();
}
