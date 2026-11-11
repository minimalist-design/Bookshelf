import { mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Library } from "../library/library.ts";
import { shelfOf } from "../library/libraryIndex.ts";
import { validateShelfName } from "../library/paths.ts";
import { detectFormat } from "../naming/formats.ts";
import type { ShelfDeleteResult } from "../../shared/types.ts";
import { ConflictError, NotFoundError, UnavailableError } from "../api/http.ts";
import { freeName, moveFileSync } from "./fileOps.ts";

export interface ShelfDeps {
  library: Library;
  hashCache: HashCacheRepo;
  events: EventBus;
}

/** OS clutter that may be discarded when a shelf directory is removed. */
const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini", "._.ds_store"]);
const PARTIAL = /\.(part|crdownload|download|tmp|partial)$|~$/i;

interface ShelfContents {
  books: string[]; // relative to the library root
  junk: string[]; // absolute
  others: string[]; // relative to the library root
  dirs: string[]; // absolute, deepest first
}

/** Shelves are the first-level directories of the library. */
export class ShelfService {
  constructor(private readonly deps: ShelfDeps) {}

  private root(): string {
    const root = this.deps.library.rootPath;
    if (!root) throw new UnavailableError("No library directory is configured");
    return root;
  }

  private existing(name: string): string {
    const shelf = validateShelfName(name);
    try {
      if (statSync(join(this.root(), shelf)).isDirectory()) return shelf;
    } catch {
      /* fall through */
    }
    throw new NotFoundError(`Bookshelf not found: ${shelf}`);
  }

  async create(name: string): Promise<string> {
    const shelf = validateShelfName(name);
    const abs = join(this.root(), shelf);
    try {
      mkdirSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ConflictError(`“${shelf}” already exists`);
      throw err;
    }
    this.deps.events.libraryChanged([]);
    return shelf;
  }

  /** Rename the directory; every file inside keeps its metadata (index + cache are moved along). */
  async rename(name: string, newName: string): Promise<string> {
    const { library, hashCache, events } = this.deps;
    return library.linker.exclusive(() => {
      const root = this.root();
      const from = this.existing(name);
      const to = validateShelfName(newName);
      if (from === to) return to;
      const caseOnly = from.toLowerCase() === to.toLowerCase();
      if (!caseOnly && existsDir(join(root, to))) throw new ConflictError(`“${to}” already exists`);
      renameSync(join(root, from), join(root, to));

      const ids = new Set<number>();
      for (const f of library.index.filesUnder(from)) {
        const rel = `${to}${f.relPath.slice(from.length)}`;
        library.index.remove(f.relPath);
        library.index.set({ ...f, relPath: rel, shelf: shelfOf(rel) });
        hashCache.rename(join(root, f.relPath), join(root, rel));
        ids.add(f.bookId);
      }
      events.libraryChanged(ids);
      return to;
    });
  }

  /**
   * Delete a shelf without ever deleting books: book files (also from subfolders) move to the
   * library root (Unshelved), OS junk is discarded, empty folders removed. If any other file is
   * present, nothing is touched and the list is returned as a conflict.
   */
  async remove(name: string): Promise<ShelfDeleteResult> {
    const { library, hashCache, events } = this.deps;
    return library.linker.exclusive(() => {
      const root = this.root();
      const shelf = this.existing(name);
      const contents = scanShelf(root, shelf);
      if (contents.others.length) {
        throw new ConflictError(`“${shelf}” contains files that are not books; move or delete them first`, {
          files: contents.others.slice(0, 50),
          total: contents.others.length,
        });
      }

      const moved: ShelfDeleteResult["moved"] = [];
      const ids = new Set<number>();
      for (const rel of contents.books) {
        const fromAbs = join(root, rel);
        const name = freeName(root, rel.slice(rel.lastIndexOf("/") + 1));
        const st = moveFileSync(fromAbs, join(root, name));
        const indexed = library.index.remove(rel);
        if (indexed) {
          library.index.set({ ...indexed, relPath: name, filename: name, shelf: null, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), ino: st.ino });
          ids.add(indexed.bookId);
        }
        // Not yet indexed (e.g. still being copied): the watcher picks it up at its new place.
        hashCache.rename(fromAbs, join(root, name));
        moved.push({ from: rel, to: name });
      }
      for (const junk of contents.junk) unlinkSync(junk);
      // rmdir (not recursive rm): fails instead of deleting anything that appeared meanwhile.
      for (const dir of contents.dirs) {
        try {
          rmdirSync(dir);
        } catch (err) {
          throw new ConflictError(`Could not remove ${dir}: ${(err as Error).message}`);
        }
      }
      events.libraryChanged(ids);
      return { moved };
    });
  }
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Classify everything inside a shelf directory. */
function scanShelf(root: string, shelf: string): ShelfContents {
  const out: ShelfContents = { books: [], junk: [], others: [], dirs: [] };
  const walk = (rel: string) => {
    const abs = join(root, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(childRel);
        continue;
      }
      const hidden = e.name.startsWith(".");
      if (JUNK_FILES.has(e.name.toLowerCase())) out.junk.push(join(root, childRel));
      else if (!hidden && e.isFile() && !PARTIAL.test(e.name) && detectFormat(e.name) && !childRel.split("/").some((s) => s.startsWith("."))) {
        out.books.push(childRel);
      } else out.others.push(childRel);
    }
    out.dirs.push(abs); // after children → deepest first
  };
  walk(shelf);
  return out;
}
