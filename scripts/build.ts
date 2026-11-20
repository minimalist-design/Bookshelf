#!/usr/bin/env bun
/**
 * Builds a self-contained executable: the server and its SQL migrations in one file, with no `node_modules` needed
 * at runtime.
 *
 *   bun run build                    → dist/bookshelf (current platform; `make build` writes ./bookshelf)
 *   bun run build --target=linux-arm64 --outfile=dist/bookshelf-arm64
 */
import { rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outfile: { type: "string", default: "dist/bookshelf" },
    target: { type: "string" },
  },
});

const outfile = resolve(ROOT, args.outfile);
const result = await Bun.build({
  entrypoints: [join(ROOT, "src/server/index.ts")],
  compile: {
    outfile,
    ...(args.target ? { target: args.target as Bun.Build.CompileTarget } : {}),
    // Configuration comes from ~/.config/bookshelf/config.json (see src/server/configFile.ts), not from files in the
    // working directory; secrets, if any, come from the environment (systemd EnvironmentFile=).
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: true,
  // Embedded in the executable so stack traces point at the original sources.
  sourcemap: "inline",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// The source maps are embedded; Bun still writes copies next to the executable, which nothing reads.
for (const output of result.outputs) if (output.path.endsWith(".map")) rmSync(output.path, { force: true });
const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`Built ${outfile} (${mb} MB)`);
