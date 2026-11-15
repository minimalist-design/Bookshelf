import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class ValidationError extends Error {}

/** Hidden directory inside the library root where uploads are staged (same filesystem → atomic rename). */
export const INCOMING_DIR = ".bookshelf-incoming";

/** True when `child` is `parent` itself or located inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Validate a candidate library root; returns its canonical path. */
export function validateLibraryRoot(input: string, dataDir: string): string {
  if (!input || !isAbsolute(input)) throw new ValidationError("Library root must be an absolute path");
  let root: string;
  try {
    root = realpathSync(resolve(input));
  } catch {
    throw new ValidationError(`Directory does not exist: ${input}`);
  }
  if (!statSync(root).isDirectory()) throw new ValidationError(`Not a directory: ${root}`);
  if (root === sep) throw new ValidationError("The filesystem root cannot be the library root");
  try {
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new ValidationError(`Directory is not readable and writable: ${root}`);
  }
  let data = resolve(dataDir);
  try {
    data = realpathSync(data);
  } catch {
    /* data dir may not exist yet */
  }
  if (isInside(root, data)) throw new ValidationError("The data directory must not be inside the library root");
  if (isInside(data, root)) throw new ValidationError("The library root must not be inside the data directory");
  return root;
}

/**
 * Validate a library root that may not exist yet: missing directories (including parents) are created.
 * Placement rules are checked before anything is created, so a rejected path leaves no stray folders.
 */
export function createLibraryRoot(input: string, dataDir: string): string {
  if (!input || !isAbsolute(input)) throw new ValidationError("Library root must be an absolute path");
  const target = resolve(input);
  if (!existsSync(target)) {
    if (target === sep) throw new ValidationError("The filesystem root cannot be the library root");
    const data = resolve(dataDir);
    if (isInside(target, data)) throw new ValidationError("The data directory must not be inside the library root");
    if (isInside(data, target)) throw new ValidationError("The library root must not be inside the data directory");
    try {
      mkdirSync(target, { recursive: true });
    } catch (err) {
      throw new ValidationError(`Cannot create directory: ${target} (${(err as NodeJS.ErrnoException).code ?? err})`);
    }
  }
  return validateLibraryRoot(input, dataDir);
}

const INVALID_DIR_CHARS = /[\/\\\0]/;

/** Validate a single directory name supplied by a client (no paths, no hidden names). */
export function validateDirName(name: string, noun = "Folder"): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError(`${noun} name is empty`);
  if (trimmed === "." || trimmed === "..") throw new ValidationError(`Invalid ${noun.toLowerCase()} name`);
  if (trimmed.startsWith(".")) throw new ValidationError(`${noun} names cannot start with a dot`);
  if (INVALID_DIR_CHARS.test(trimmed)) throw new ValidationError(`${noun} names cannot contain slashes`);
  if (Buffer.byteLength(trimmed) > 255) throw new ValidationError(`${noun} name is too long`);
  return trimmed;
}

/** Validate a bookshelf (first-level directory) name supplied by a client. */
export function validateShelfName(name: string): string {
  return validateDirName(name, "Shelf");
}
