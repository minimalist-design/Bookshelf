#!/usr/bin/env bun
/**
 * Builds a self-contained executable: server, pre-bundled web app, SQL migrations and pdf.js assets, all in one
 * file with no `node_modules` needed at runtime.
 *
 *   bun run build                    → dist/bookshelf (current platform)
 *   bun run build --target=linux-arm64 --outfile=dist/bookshelf-arm64
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PDFJS_KINDS, PDFJS_WORKER } from "../src/server/api/pdfjsAssets.ts";

const ROOT = resolve(import.meta.dir, "..");
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outfile: { type: "string", default: "dist/bookshelf" },
    target: { type: "string" },
  },
});

/** Replaces `src/server/api/pdfjsAssets.ts` with a version that embeds every served file in the executable. */
const pdfjsEmbedPlugin: Bun.BunPlugin = {
  name: "embed-pdfjs-assets",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]server[\\/]api[\\/]pdfjsAssets\.ts$/ }, () => {
      const pdfjsDir = dirname(Bun.resolveSync("pdfjs-dist/package.json", ROOT));
      const imports: string[] = [];
      const entries: string[] = [];
      for (const [kind, { dir }] of Object.entries(PDFJS_KINDS)) {
        for (const name of readdirSync(join(pdfjsDir, dir)).sort()) {
          // The browser only requests the minified worker; skip the full one and its source map.
          if (kind === "build" ? name !== "pdf.worker.min.mjs" : name.startsWith(".")) continue;
          const id = `f${imports.length}`;
          imports.push(`import ${id} from ${JSON.stringify(join(pdfjsDir, dir, name))} with { type: "file" };`);
          entries.push(`  ${JSON.stringify(`${kind}/${name}`)}: ${id},`);
        }
      }
      const contents = [
        ...imports,
        `export const PDFJS_KINDS = ${JSON.stringify(PDFJS_KINDS)};`,
        `export const PDFJS_WORKER = ${PDFJS_WORKER};`,
        `const FILES = new Map(Object.entries({\n${entries.join("\n")}\n}));`,
        `export function pdfjsAssetPath(kind, name) { return FILES.get(kind + "/" + name) ?? null; }`,
      ].join("\n");
      console.log(`Embedding ${imports.length} pdf.js assets`);
      return { contents, loader: "js" };
    });
  },
};

const outfile = resolve(ROOT, args.outfile);
const result = await Bun.build({
  entrypoints: [join(ROOT, "src/server/index.ts")],
  compile: {
    outfile,
    ...(args.target ? { target: args.target as Bun.Build.CompileTarget } : {}),
    // Configuration comes from BOOKSHELF_* environment variables, not from files in the working directory.
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: true,
  // Embedded in the executable so stack traces point at the original sources.
  sourcemap: "inline",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [pdfjsEmbedPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// The source maps are embedded; Bun still writes copies next to the executable, which nothing reads.
for (const output of result.outputs) if (output.path.endsWith(".map")) rmSync(output.path, { force: true });
const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`Built ${outfile} (${mb} MB)`);
