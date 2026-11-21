import { existsSync, renameSync } from "node:fs";
import { join, posix } from "node:path";
import type { AppContext } from "../app.ts";
import * as bookRepo from "../db/repo/books.ts";
import type { BookRecord } from "../db/repo/books.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import type { IndexedFile } from "../library/libraryIndex.ts";
import { buildLibraryFilename, withCollisionSuffix } from "../naming/buildFilename.ts";
import { detectFormat } from "../naming/formats.ts";
import type { BulkRenameResult, RenameResult } from "../../shared/types.ts";
import { eachSettled } from "./fileOps.ts";

export type RenameDeps = Pick<AppContext, "db" | "library">;

interface Rename {
  file: IndexedFile;
  fromAbs: string;
  toAbs: string;
  toRel: string;
  name: string;
}

/** A free name for the library filename in `dirAbs`; the file's own current name counts as free. */
function freeNameFor(dirAbs: string, base: string, ext: string, current: string): string {
  let n = 1;
  let name = base;
  while (name !== current && existsSync(join(dirAbs, name))) name = withCollisionSuffix(base, ext, ++n);
  return name;
}

/** Where a file goes under the library pattern, or null when it is already named that way. */
function planRename(root: string, book: BookRecord, file: IndexedFile): Rename | null {
  const detected = detectFormat(file.filename);
  if (!detected) return null;
  const ext = detected.ext.toLowerCase();
  const dirRel = posix.dirname(file.relPath);
  const dirAbs = dirRel === "." ? root : join(root, dirRel);
  const base = buildLibraryFilename(book, ext);
  if (file.filename === base) return null;
  const name = freeNameFor(dirAbs, base, ext, file.filename);
  if (name === file.filename) return null;
  return { file, fromAbs: join(dirAbs, file.filename), toAbs: join(dirAbs, name), toRel: dirRel === "." ? name : `${dirRel}/${name}`, name };
}

/**
 * Rename every on-disk file of a book to `{author} - {title} [{id}].{ext}` in its current
 * directory. Must run inside `linker.exclusive`; synchronous so the index and hash cache are
 * updated together with the files (a later scan then sees nothing new).
 */
export function renameBookFiles(deps: RenameDeps, bookId: number): BulkRenameResult {
  const { db, library } = deps;
  const root = library.rootPath;
  const book = bookRepo.get(db, bookId);
  if (!root || !book) return { renamed: [], errors: [] };

  const plans = library.index.filesOfBook(bookId).flatMap((file) => planRename(root, book, file) ?? []);
  const { done, errors } = eachSettled(
    plans,
    (p) => p.file.relPath,
    (p): RenameResult => {
      renameSync(p.fromAbs, p.toAbs);
      library.index.remove(p.file.relPath);
      library.index.set({ ...p.file, relPath: p.toRel, filename: p.name });
      hashCacheRepo.rename(db, p.fromAbs, p.toAbs);
      return { from: p.file.relPath, to: p.toRel };
    },
  );
  return { renamed: done, errors };
}
