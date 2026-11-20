/** Shelves are the first-level directories of the library. */
import { mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import { shelfOf } from "../library/libraryIndex.ts";
import { validateShelfName } from "../library/paths.ts";
import { detectFormat } from "../naming/formats.ts";
import type { RenameResult, ShelfDeleteResult } from "../../shared/types.ts";
import { ConflictError, NotFoundError, UnavailableError } from "../api/http.ts";
import { freeName, moveFileSync } from "./fileOps.ts";

type Deps = Pick<AppContext, "db" | "library" | "events">;

/** OS clutter that may be discarded when a shelf directory is removed. */
const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini", "._.ds_store"]);
const PARTIAL = /\.(part|crdownload|download|tmp|partial)$|~$/i;

export type EntryKind = "book" | "junk" | "other";

/** What a file inside a shelf is: a book file, OS junk, or anything else (which blocks deleting the shelf). */
export function classifyEntry(name: string, relPath: string, isFile: boolean): EntryKind {
  if (JUNK_FILES.has(name.toLowerCase())) return "junk";
  const hidden = relPath.split("/").some((s) => s.startsWith("."));
  return !hidden && isFile && !PARTIAL.test(name) && detectFormat(name) ? "book" : "other";
}

interface ShelfContents {
  books: string[]; // relative to the library root
  junk: string[]; // absolute
  others: string[]; // relative to the library root
  dirs: string[]; // absolute, deepest first
}

const EMPTY: ShelfContents = { books: [], junk: [], others: [], dirs: [] };

const concat = (a: ShelfContents, b: ShelfContents): ShelfContents => ({
  books: [...a.books, ...b.books],
  junk: [...a.junk, ...b.junk],
  others: [...a.others, ...b.others],
  dirs: [...a.dirs, ...b.dirs],
});

/** Classify everything inside a shelf directory, in directory order. */
function scanShelf(root: string, rel: string): ShelfContents {
  const entries: Dirent[] = readdirSync(join(root, rel), { withFileTypes: true });
  const inside = entries
    .map((e): ShelfContents => {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) return scanShelf(root, childRel);
      const kind = classifyEntry(e.name, childRel, e.isFile());
      return kind === "book" ? { ...EMPTY, books: [childRel] } : kind === "junk" ? { ...EMPTY, junk: [join(root, childRel)] } : { ...EMPTY, others: [childRel] };
    })
    .reduce(concat, EMPTY);
  return concat(inside, { ...EMPTY, dirs: [join(root, rel)] }); // after children → deepest first
}

function rootOf(deps: Pick<AppContext, "library">): string {
  const root = deps.library.rootPath;
  if (!root) throw new UnavailableError("No library directory is configured");
  return root;
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existing(root: string, name: string): string {
  const shelf = validateShelfName(name);
  if (existsDir(join(root, shelf))) return shelf;
  throw new NotFoundError(`Bookshelf not found: ${shelf}`);
}

export async function create(deps: Pick<AppContext, "library" | "events">, name: string): Promise<string> {
  const shelf = validateShelfName(name);
  try {
    mkdirSync(join(rootOf(deps), shelf));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ConflictError(`“${shelf}” already exists`);
    throw err;
  }
  deps.events.libraryChanged([]);
  return shelf;
}

/** Rename the directory; every file inside keeps its metadata (index + cache are moved along). */
export async function rename(deps: Deps, name: string, newName: string): Promise<string> {
  const { db, library, events } = deps;
  return library.linker.exclusive(() => {
    const root = rootOf(deps);
    const from = existing(root, name);
    const to = validateShelfName(newName);
    if (from === to) return to;
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    if (!caseOnly && existsDir(join(root, to))) throw new ConflictError(`“${to}” already exists`);
    renameSync(join(root, from), join(root, to));

    const files = library.index.filesUnder(from);
    for (const f of files) {
      const rel = `${to}${f.relPath.slice(from.length)}`;
      library.index.remove(f.relPath);
      library.index.set({ ...f, relPath: rel, shelf: shelfOf(rel) });
      hashCacheRepo.rename(db, join(root, f.relPath), join(root, rel));
    }
    events.libraryChanged(new Set(files.map((f) => f.bookId)));
    return to;
  });
}

/**
 * Delete a shelf without ever deleting books: book files (also from subfolders) move to the
 * library root (Unshelved), OS junk is discarded, empty folders removed. If any other file is
 * present, nothing is touched and the list is returned as a conflict.
 */
export async function remove(deps: Deps, name: string): Promise<ShelfDeleteResult> {
  const { db, library, events } = deps;
  return library.linker.exclusive(() => {
    const root = rootOf(deps);
    const shelf = existing(root, name);
    const contents = scanShelf(root, shelf);
    if (contents.others.length) {
      throw new ConflictError(`“${shelf}” contains files that are not books; move or delete them first`, {
        files: contents.others.slice(0, 50),
        total: contents.others.length,
      });
    }

    const moved: (RenameResult & { bookId: number | null })[] = [];
    for (const rel of contents.books) {
      const fromAbs = join(root, rel);
      const target = freeName(root, rel.slice(rel.lastIndexOf("/") + 1));
      const st = moveFileSync(fromAbs, join(root, target));
      const indexed = library.index.remove(rel);
      if (indexed) {
        library.index.set({ ...indexed, relPath: target, filename: target, shelf: null, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), ino: st.ino });
      }
      // Not yet indexed (e.g. still being copied): the watcher picks it up at its new place.
      hashCacheRepo.rename(db, fromAbs, join(root, target));
      moved.push({ from: rel, to: target, bookId: indexed?.bookId ?? null });
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
    events.libraryChanged(new Set(moved.flatMap((m) => (m.bookId === null ? [] : [m.bookId]))));
    return { moved: moved.map(({ from, to }) => ({ from, to })) };
  });
}
