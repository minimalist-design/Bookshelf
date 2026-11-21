import type { BookFormat } from "../naming/formats.ts";

/** A book file currently present on disk. */
export interface IndexedFile {
  relPath: string; // POSIX-style path relative to the library root
  readonly filename: string;
  shelf: string | null; // null = Unshelved (directly in root)
  readonly format: BookFormat;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly hash: string;
  readonly bookId: number;
}

export function shelfOf(relPath: string): string | null {
  const i = relPath.indexOf("/");
  return i === -1 ? null : relPath.slice(0, i);
}

/** Identity of a file on disk regardless of its path (the same file, possibly moved). */
export function inodeKey(ino: number, size: number, mtimeMs: number): string {
  return `${ino}:${size}:${Math.trunc(mtimeMs)}`;
}

/**
 * Which book files exist. Built from disk by full scans and kept up to date by the app's own
 * file operations; this — never the database — decides what the library contains.
 *
 * It is mutable on purpose (a library can hold many thousands of files, changed one at a time);
 * every change happens under the linker's lock, so there is a single writer.
 */
export interface LibraryIndex {
  readonly size: number;
  get(relPath: string): IndexedFile | undefined;
  set(file: IndexedFile): void;
  /** Indexed file with the same inode, size and mtime (i.e. the same file, possibly moved). */
  findByInode(ino: number, size: number, mtimeMs: number): IndexedFile | undefined;
  remove(relPath: string): IndexedFile | undefined;
  /** Remove every file under a directory (relative path without trailing slash). */
  removeUnder(dirRel: string): IndexedFile[];
  filesUnder(dirRel: string): IndexedFile[];
  /** The book's files, ordered by format. */
  filesOfBook(bookId: number): IndexedFile[];
  hasBook(bookId: number): boolean;
  /** Whether the book already has an on-disk file of this format (other than `exceptRel`). */
  bookHasFormat(bookId: number, format: BookFormat, exceptRel?: string): boolean;
  /** On-disk file with this content hash, if any. */
  fileWithHash(hash: string): IndexedFile | undefined;
  bookIds(): number[];
  allFiles(): MapIterator<IndexedFile>;
  clear(): void;
}

const under = (dirRel: string) => (dirRel === "" ? "" : `${dirRel}/`);

export function createLibraryIndex(): LibraryIndex {
  const files = new Map<string, IndexedFile>();
  const byBook = new Map<number, Set<string>>();
  const byInode = new Map<string, string>();

  const remove = (relPath: string): IndexedFile | undefined => {
    const f = files.get(relPath);
    if (!f) return undefined;
    files.delete(relPath);
    const key = inodeKey(f.ino, f.size, f.mtimeMs);
    if (byInode.get(key) === relPath) byInode.delete(key);
    const set = byBook.get(f.bookId);
    set?.delete(relPath);
    if (set && set.size === 0) byBook.delete(f.bookId);
    return f;
  };

  const filesOfBook = (bookId: number): IndexedFile[] =>
    [...(byBook.get(bookId) ?? [])].map((rel) => files.get(rel)!).toSorted((a, b) => a.format.localeCompare(b.format));

  return {
    get size() {
      return files.size;
    },
    get: (relPath) => files.get(relPath),
    set(file) {
      remove(file.relPath);
      files.set(file.relPath, file);
      byBook.set(file.bookId, (byBook.get(file.bookId) ?? new Set()).add(file.relPath));
      byInode.set(inodeKey(file.ino, file.size, file.mtimeMs), file.relPath);
    },
    findByInode(ino, size, mtimeMs) {
      const rel = byInode.get(inodeKey(ino, size, mtimeMs));
      return rel === undefined ? undefined : files.get(rel);
    },
    remove,
    removeUnder: (dirRel) =>
      [...files.keys()].filter((rel) => rel.startsWith(under(dirRel))).map((rel) => remove(rel)!),
    filesUnder: (dirRel) => [...files.values()].filter((f) => f.relPath.startsWith(under(dirRel))),
    filesOfBook,
    hasBook: (bookId) => byBook.has(bookId),
    bookHasFormat: (bookId, format, exceptRel) => filesOfBook(bookId).some((f) => f.relPath !== exceptRel && f.format === format),
    fileWithHash: (hash) => files.values().find((f) => f.hash === hash),
    bookIds: () => [...byBook.keys()],
    allFiles: () => files.values(),
    clear() {
      files.clear();
      byBook.clear();
      byInode.clear();
    },
  };
}
