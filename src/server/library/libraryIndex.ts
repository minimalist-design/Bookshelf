import type { BookFormat } from "../naming/formats.ts";

/** A book file currently present on disk. */
export interface IndexedFile {
  relPath: string; // POSIX-style path relative to the library root
  filename: string;
  shelf: string | null; // null = Unshelved (directly in root)
  format: BookFormat;
  size: number;
  mtimeMs: number;
  ino: number;
  hash: string;
  bookId: number;
}

export function shelfOf(relPath: string): string | null {
  const i = relPath.indexOf("/");
  return i === -1 ? null : relPath.slice(0, i);
}

/**
 * The live view of which book files exist. Built from disk and kept in sync by the
 * watcher; this — never the database — decides what the library contains.
 */
export class LibraryIndex {
  private readonly files = new Map<string, IndexedFile>();
  private readonly byBook = new Map<number, Set<string>>();
  private readonly byInode = new Map<string, string>();

  private static inodeKey(ino: number, size: number, mtimeMs: number): string {
    return `${ino}:${size}:${Math.trunc(mtimeMs)}`;
  }

  get size(): number {
    return this.files.size;
  }

  get(relPath: string): IndexedFile | undefined {
    return this.files.get(relPath);
  }

  set(file: IndexedFile): void {
    this.remove(file.relPath);
    this.files.set(file.relPath, file);
    let set = this.byBook.get(file.bookId);
    if (!set) this.byBook.set(file.bookId, (set = new Set()));
    set.add(file.relPath);
    this.byInode.set(LibraryIndex.inodeKey(file.ino, file.size, file.mtimeMs), file.relPath);
  }

  /** Indexed file with the same inode, size and mtime (i.e. the same file, possibly moved). */
  findByInode(ino: number, size: number, mtimeMs: number): IndexedFile | undefined {
    const rel = this.byInode.get(LibraryIndex.inodeKey(ino, size, mtimeMs));
    return rel === undefined ? undefined : this.files.get(rel);
  }

  remove(relPath: string): IndexedFile | undefined {
    const f = this.files.get(relPath);
    if (!f) return undefined;
    this.files.delete(relPath);
    const key = LibraryIndex.inodeKey(f.ino, f.size, f.mtimeMs);
    if (this.byInode.get(key) === relPath) this.byInode.delete(key);
    const set = this.byBook.get(f.bookId);
    set?.delete(relPath);
    if (set && set.size === 0) this.byBook.delete(f.bookId);
    return f;
  }

  /** Remove every file under a directory (relative path without trailing slash). */
  removeUnder(dirRel: string): IndexedFile[] {
    const prefix = dirRel === "" ? "" : `${dirRel}/`;
    const removed: IndexedFile[] = [];
    for (const rel of [...this.files.keys()]) {
      if (rel.startsWith(prefix)) removed.push(this.remove(rel)!);
    }
    return removed;
  }

  filesUnder(dirRel: string): IndexedFile[] {
    const prefix = dirRel === "" ? "" : `${dirRel}/`;
    return [...this.files.values()].filter((f) => f.relPath.startsWith(prefix));
  }

  filesOfBook(bookId: number): IndexedFile[] {
    const set = this.byBook.get(bookId);
    return set ? [...set].map((rel) => this.files.get(rel)!).sort((a, b) => a.format.localeCompare(b.format)) : [];
  }

  hasBook(bookId: number): boolean {
    return this.byBook.has(bookId);
  }

  /** Whether the book already has an on-disk file of this format (other than `exceptRel`). */
  bookHasFormat(bookId: number, format: BookFormat, exceptRel?: string): boolean {
    const set = this.byBook.get(bookId);
    if (!set) return false;
    for (const rel of set) if (rel !== exceptRel && this.files.get(rel)!.format === format) return true;
    return false;
  }

  /** On-disk file with this content hash, if any. */
  fileWithHash(hash: string): IndexedFile | undefined {
    for (const f of this.files.values()) if (f.hash === hash) return f;
    return undefined;
  }

  bookIds(): number[] {
    return [...this.byBook.keys()];
  }

  allFiles(): IterableIterator<IndexedFile> {
    return this.files.values();
  }

  clear(): void {
    this.files.clear();
    this.byBook.clear();
    this.byInode.clear();
  }
}
