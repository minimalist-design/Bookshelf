import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BrowseResult } from "../../shared/types.ts";
import { validateDirName, ValidationError } from "../library/paths.ts";
import { ConflictError, NotFoundError } from "./http.ts";

/** List subdirectories of a server path (directories only, hidden ones excluded). */
export function browseDirectories(input: string | null): BrowseResult {
  let path: string;
  try {
    path = realpathSync(resolve(input || homedir()));
  } catch {
    throw new NotFoundError(`Directory does not exist: ${input}`);
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

/** Create directory `name` inside the existing directory `parent`; returns the new directory's path. */
export function makeDirectory(parent: unknown, name: unknown): { path: string } {
  if (typeof parent !== "string" || !parent) throw new ValidationError("parent must be a directory path");
  if (typeof name !== "string") throw new ValidationError("name must be a string");
  let dir: string;
  try {
    dir = realpathSync(resolve(parent));
  } catch {
    throw new NotFoundError(`Directory does not exist: ${parent}`);
  }
  if (!isDir(dir)) throw new ValidationError(`Not a directory: ${dir}`);
  const path = join(dir, validateDirName(name));
  try {
    mkdirSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new ConflictError(`Already exists: ${path}`);
    throw new ValidationError(`Cannot create directory: ${path} (${code ?? err})`);
  }
  return { path };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
