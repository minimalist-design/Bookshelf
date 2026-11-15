import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Files the browser PDF reader fetches from `/vendor/pdfjs/:kind/:name`: the worker, CMaps, standard fonts,
 * the WebAssembly image decoders (JBIG2, JPEG 2000, colour management, with their non-wasm fallbacks) and the
 * ICC profile used for CMYK.
 *
 * This implementation reads them from `node_modules/pdfjs-dist`. The compiled binary has no `node_modules`, so
 * `scripts/build.ts` replaces this module with one that embeds every allowed file (see `pdfjsEmbedPlugin`). Both
 * versions export the same `PDFJS_KINDS` and `pdfjsAssetPath`.
 *
 * `files` is a regex source (kept a string so the build script can serialize the table) of the names served.
 */
export const PDFJS_KINDS: Record<string, { dir: string; files: string }> = {
  build: { dir: "legacy/build", files: "^pdf\\.worker\\.min\\.mjs$" },
  cmaps: { dir: "cmaps", files: "\\.bcmap$" },
  standard_fonts: { dir: "standard_fonts", files: "\\.(pfb|ttf)$" },
  // quickjs (PDF scripting) is left out: scripting is disabled.
  wasm: { dir: "wasm", files: "^(jbig2|openjpeg|qcms_bg)\\.wasm$|^(jbig2|openjpeg)_nowasm_fallback\\.js$" },
  iccs: { dir: "iccs", files: "\\.icc$" },
};

/** Whether `name` is a servable file of `kind` (plain names only, no LICENSE files etc.). */
export function isPdfjsAsset(kind: string, name: string): boolean {
  const k = PDFJS_KINDS[kind];
  return !!k && /^[\w.-]+$/.test(name) && !name.startsWith(".") && new RegExp(k.files).test(name);
}

let pdfjsDir: string | undefined;

/** Absolute path of an allowed asset, or null. `kind` must be a `PDFJS_KINDS` key and `name` a plain file name. */
export function pdfjsAssetPath(kind: string, name: string): string | null {
  if (!isPdfjsAsset(kind, name)) return null;
  pdfjsDir ??= dirname(Bun.resolveSync("pdfjs-dist/package.json", import.meta.dir));
  const path = join(pdfjsDir, PDFJS_KINDS[kind]!.dir, name);
  return existsSync(path) ? path : null;
}
