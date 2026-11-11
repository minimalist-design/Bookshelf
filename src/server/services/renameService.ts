import { existsSync, renameSync } from "node:fs";
import { join, posix } from "node:path";
import type { BooksRepo } from "../db/repo/books.ts";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { Library } from "../library/library.ts";
import { buildLibraryFilename, withCollisionSuffix } from "../naming/buildFilename.ts";
import { detectFormat } from "../naming/formats.ts";
import type { BulkRenameResult } from "../../shared/types.ts";

export interface RenameDeps {
  library: Library;
  books: BooksRepo;
  hashCache: HashCacheRepo;
}

/**
 * Rename every on-disk file of a book to `{author} - {title} [{id}].{ext}` in its current
 * directory. Must run inside `linker.exclusive`; synchronous so the index and hash cache are
 * updated before the watcher reacts (it then sees nothing new).
 */
export function renameBookFiles(deps: RenameDeps, bookId: number): BulkRenameResult {
  const { library, books, hashCache } = deps;
  const root = library.rootPath;
  const book = books.get(bookId);
  const out: BulkRenameResult = { renamed: [], errors: [] };
  if (!root || !book) return out;

  for (const file of library.index.filesOfBook(bookId)) {
    const detected = detectFormat(file.filename);
    if (!detected) continue;
    const ext = detected.ext.toLowerCase();
    const dirRel = posix.dirname(file.relPath);
    const dirAbs = dirRel === "." ? root : join(root, dirRel);
    const base = buildLibraryFilename(book, ext);
    if (file.filename === base) continue;

    // Find a free name; the file's own current name counts as free.
    let n = 1;
    let name = base;
    while (name !== file.filename && existsSync(join(dirAbs, name))) name = withCollisionSuffix(base, ext, ++n);
    if (name === file.filename) continue;

    const fromAbs = join(dirAbs, file.filename);
    const toAbs = join(dirAbs, name);
    const toRel = dirRel === "." ? name : `${dirRel}/${name}`;
    try {
      renameSync(fromAbs, toAbs);
    } catch (err) {
      out.errors.push(`${file.relPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    library.index.remove(file.relPath);
    library.index.set({ ...file, relPath: toRel, filename: name });
    hashCache.rename(fromAbs, toAbs);
    out.renamed.push({ from: file.relPath, to: toRel });
  }
  return out;
}
