import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Files the browser PDF reader fetches from `/vendor/pdfjs/:kind/:name`: the worker, CMaps and standard fonts.
 *
 * This implementation reads them from `node_modules/pdfjs-dist`. The compiled binary has no `node_modules`, so
 * `scripts/build.ts` replaces this module with one that embeds every file (see `pdfjsEmbedPlugin`). Both versions
 * export the same `PDFJS_KINDS` and `pdfjsAssetPath`.
 */
export const PDFJS_KINDS: Record<string, { dir: string; type: string }> = {
  build: { dir: "legacy/build", type: "text/javascript" },
  cmaps: { dir: "cmaps", type: "application/octet-stream" },
  standard_fonts: { dir: "standard_fonts", type: "application/octet-stream" },
};

/** Only the worker is served from the build directory. */
export const PDFJS_WORKER = /^pdf\.worker(\.min)?\.mjs$/;

let pdfjsDir: string | undefined;

/** Absolute path of an allowed asset, or null. `kind` must be a `PDFJS_KINDS` key and `name` a plain file name. */
export function pdfjsAssetPath(kind: string, name: string): string | null {
  const k = PDFJS_KINDS[kind];
  if (!k || !/^[\w.-]+$/.test(name) || name.startsWith(".") || (kind === "build" && !PDFJS_WORKER.test(name))) return null;
  pdfjsDir ??= dirname(Bun.resolveSync("pdfjs-dist/package.json", import.meta.dir));
  const path = join(pdfjsDir, k.dir, name);
  return existsSync(path) ? path : null;
}
