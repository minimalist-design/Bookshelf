import { readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { detectFormat, type DetectedFormat } from "../naming/formats.ts";

export interface WalkedFile {
  abs: string;
  rel: string;
  stat: Stats;
  detected: DetectedFormat;
}

const PARTIAL = /\.(part|crdownload|download|tmp|partial)$|~$/i;

/** Hidden entries (and therefore the app's `.bookshelf-incoming/`) are never part of the library. */
export function isIgnoredRelPath(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith(".")) || PARTIAL.test(rel);
}

export function toRel(parts: string[]): string {
  return parts.join("/");
}

/**
 * Recursively yield supported book files below `dirAbs`. Symlinked files are
 * followed; symlinked directories are not (avoids cycles). Unreadable entries are skipped.
 */
export async function* walkBooks(rootAbs: string, dirRel = ""): AsyncGenerator<WalkedFile> {
  const dirAbs = dirRel ? join(rootAbs, dirRel) : rootAbs;
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    const abs = join(dirAbs, e.name);
    if (e.isDirectory()) {
      yield* walkBooks(rootAbs, rel);
      continue;
    }
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    if (PARTIAL.test(e.name)) continue;
    const detected = detectFormat(e.name);
    if (!detected) continue;
    let st: Stats;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    yield { abs, rel, stat: st, detected };
  }
}
