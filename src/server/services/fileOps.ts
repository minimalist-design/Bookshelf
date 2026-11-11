import { constants, copyFileSync, existsSync, renameSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { IndexedFile, LibraryIndex } from "../library/libraryIndex.ts";
import { shelfOf } from "../library/libraryIndex.ts";
import { detectFormat } from "../naming/formats.ts";
import { withCollisionSuffix } from "../naming/buildFilename.ts";

/**
 * Move a file, falling back to copy + unlink across filesystems (a shelf may be a mount point).
 * Synchronous on purpose: callers update the index before the watcher can react.
 */
export function moveFileSync(from: string, to: string): Stats {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    unlinkSync(from);
  }
  return statSync(to);
}

/** First free name in `dirAbs` for `filename`: "name.ext", "name (2).ext", … */
export function freeName(dirAbs: string, filename: string): string {
  const ext = detectFormat(filename)?.ext ?? "";
  let n = 1;
  let name = filename;
  while (existsSync(join(dirAbs, name))) name = withCollisionSuffix(filename, ext, ++n);
  return name;
}

/**
 * Move an indexed book file into `targetDirRel` ("" = library root), keeping its name
 * (plus a counter on collision), and update index + hash cache accordingly.
 */
export function relocateIndexedFile(
  root: string,
  index: LibraryIndex,
  hashCache: HashCacheRepo,
  file: IndexedFile,
  targetDirRel: string,
): { from: string; to: string } {
  const targetAbs = targetDirRel ? join(root, targetDirRel) : root;
  const name = freeName(targetAbs, file.filename);
  const fromAbs = join(root, file.relPath);
  const toAbs = join(targetAbs, name);
  const toRel = targetDirRel ? `${targetDirRel}/${name}` : name;
  const st = moveFileSync(fromAbs, toAbs);
  index.remove(file.relPath);
  index.set({
    ...file,
    relPath: toRel,
    filename: name,
    shelf: shelfOf(toRel),
    size: st.size,
    mtimeMs: Math.trunc(st.mtimeMs),
    ino: st.ino,
  });
  hashCache.delete(fromAbs);
  hashCache.put(toAbs, st.size, st.mtimeMs, file.hash);
  return { from: file.relPath, to: toRel };
}
