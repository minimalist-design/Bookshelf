import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BrowseResult } from "../../shared/types.ts";
import { ValidationError } from "../library/paths.ts";

/** List subdirectories of a server path (directories only, hidden ones excluded). */
export function browseDirectories(input: string | null): BrowseResult {
  let path: string;
  try {
    path = realpathSync(resolve(input || homedir()));
  } catch {
    throw new ValidationError(`Directory does not exist: ${input}`);
  }
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    throw new ValidationError(`Cannot read directory: ${path}`);
  }
  const dirs = entries
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(join(path, e.name)))))
    .map((e) => ({ name: e.name, path: join(path, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, dirs };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
