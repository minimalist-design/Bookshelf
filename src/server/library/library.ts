import { rmSync, watch, type FSWatcher, type Stats } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { BooksRepo } from "../db/repo/books.ts";
import type { HashCacheRepo } from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Extractor } from "../extract/index.ts";
import { FORMAT_METADATA_RANK } from "../extract/merge.ts";
import type { RawMetadata } from "../metadata/types.ts";
import { detectFormat } from "../naming/formats.ts";
import type { LibraryState, LibraryStatus } from "../../shared/types.ts";
import { LibraryIndex, type IndexedFile } from "./libraryIndex.ts";
import { Linker, type LinkerDeps, type LinkResult } from "./linker.ts";
import { Retention } from "./retention.ts";
import { INCOMING_DIR } from "./paths.ts";
import { isIgnoredRelPath, walkBooks, type WalkedFile } from "./walk.ts";

export interface LibraryOptions {
  /** Per-path debounce of watcher events. */
  debounceMs: number;
  /** A new/changed file must keep the same size+mtime this long before it is processed. */
  stableMs: number;
  /** Delay before metadata of a book whose last file vanished is evaluated for deletion. */
  graceMs: number;
  scanConcurrency: number;
  /** Fallback full-rescan interval when recursive watching is unavailable. */
  pollIntervalMs: number;
}

export const DEFAULT_LIBRARY_OPTIONS: LibraryOptions = {
  debounceMs: 500,
  stableMs: 2000,
  graceMs: 10_000,
  scanConcurrency: 4,
  pollIntervalMs: 60_000,
};

export interface LibraryDeps {
  books: BooksRepo;
  hashCache: HashCacheRepo;
  extract: Extractor;
  events: EventBus;
  onLinkedNew?: LinkerDeps["onLinkedNew"];
  /** Rows deleted by the retention rule (e.g. to remove cover files). */
  onBooksDeleted?: (bookIds: number[]) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOVE_MEMORY_MS = 60_000;

/**
 * Owns the live view of the library directory: full scans, the recursive watcher,
 * linking files to metadata and the retention rule.
 */
export class Library {
  readonly index = new LibraryIndex();
  readonly linker: Linker;
  readonly retention: Retention;
  private readonly opts: LibraryOptions;

  private root: string | null = null;
  private state: LibraryState = "no-root";
  private message: string | null = null;
  private scanProgress: { done: number; total: number } | null = null;
  private generation = 0;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pathLocks = new Map<string, Promise<unknown>>();
  /** Files that just disappeared, keyed by inode+size+mtime, so a move can reuse the hash. */
  private readonly recentlyRemoved = new Map<string, { hash: string; at: number }>();
  private scanPromise: Promise<void> | null = null;
  private lastStatusEmit = 0;

  constructor(private readonly deps: LibraryDeps, opts: Partial<LibraryOptions> = {}) {
    this.opts = { ...DEFAULT_LIBRARY_OPTIONS, ...opts };
    this.retention = new Retention({
      books: deps.books,
      index: this.index,
      graceMs: this.opts.graceMs,
      onDeleted: (ids) => {
        deps.onBooksDeleted?.(ids);
        deps.events.libraryChanged(ids);
      },
    });
    this.linker = new Linker({
      books: deps.books,
      hashCache: deps.hashCache,
      extract: deps.extract,
      index: this.index,
      onLinkedNew: deps.onLinkedNew,
    });
  }

  get rootPath(): string | null {
    return this.root;
  }

  status(): LibraryStatus {
    return {
      state: this.state,
      root: this.root,
      scan: this.scanProgress,
      fileCount: this.index.size,
      bookCount: this.index.bookIds().length,
      watching: this.watcher !== null,
      message: this.message,
    };
  }

  /** Switch to `root` (or none): stops watching, clears the index, starts watcher + full scan. */
  async open(root: string | null): Promise<void> {
    await this.close();
    this.root = root;
    this.state = root ? "scanning" : "no-root";
    this.emitStatus(true);
    if (!root) return;
    // Leftovers of uploads interrupted by a crash/restart.
    rmSync(join(root, INCOMING_DIR), { recursive: true, force: true });
    await this.rescan(); // starts the watcher once the root is accessible
  }

  async close(): Promise<void> {
    this.generation++;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.retention.stop();
    this.index.clear();
    this.scanProgress = null;
    this.scanPromise = null;
  }

  /** Resolves once no full scan is running (the index is complete). */
  async whenReady(): Promise<void> {
    while (this.scanPromise) await this.scanPromise;
  }

  /** Full reconciliation of the index with the disk. Concurrent calls share one run. */
  rescan(): Promise<void> {
    if (!this.scanPromise) {
      this.scanPromise = this.fullScan().finally(() => {
        this.scanPromise = null;
      });
    }
    return this.scanPromise;
  }

  // ---- full scan ------------------------------------------------------------

  private async fullScan(): Promise<void> {
    const gen = this.generation;
    const root = this.root;
    if (!root) return;

    try {
      await access(root, constants.R_OK | constants.X_OK);
    } catch {
      if (gen !== this.generation) return;
      this.state = "unavailable";
      this.message = `Library directory is not accessible: ${root}`;
      this.startPolling(); // recover automatically when it comes back (e.g. drive mounted)
      this.emitStatus(true);
      return;
    }
    if (gen !== this.generation) return; // closed or re-opened meanwhile
    if (!this.watcher) this.startWatching();

    this.state = "scanning";
    this.message = null;
    const found: WalkedFile[] = [];
    for await (const f of walkBooks(root)) {
      if (gen !== this.generation) return;
      found.push(f);
    }
    // Best metadata sources first, so multi-format books are usually created from their richest file.
    found.sort((a, b) => FORMAT_METADATA_RANK[a.detected.format] - FORMAT_METADATA_RANK[b.detected.format]);
    this.scanProgress = { done: 0, total: found.length };
    this.emitStatus(true);

    const seen = new Set<string>(found.map((f) => f.rel));
    let next = 0;
    const worker = async () => {
      while (next < found.length && gen === this.generation) {
        const f = found[next++]!;
        try {
          await this.reconcileFile(f, { waitStable: false });
        } catch (err) {
          console.warn(`Failed to process ${f.rel}:`, err);
        }
        this.scanProgress!.done++;
        this.emitStatus();
      }
    };
    await Promise.all(Array.from({ length: this.opts.scanConcurrency }, worker));
    if (gen !== this.generation) return;

    // Files indexed earlier that no longer exist (rescans).
    for (const f of [...this.index.allFiles()]) {
      if (!seen.has(f.relPath)) this.dropFile(f.relPath);
    }
    this.deps.hashCache.prune(new Set(found.map((f) => f.abs)));
    const { skipped } = this.retention.reconcile(found.length);
    if (skipped) this.message = "Library appears empty; kept all metadata (is the drive mounted?)";

    this.state = "ready";
    this.scanProgress = null;
    this.emitStatus(true);
    this.deps.events.libraryChanged([]);
  }

  // ---- watcher --------------------------------------------------------------

  private startWatching(): void {
    const root = this.root!;
    try {
      this.watcher = watch(root, { recursive: true }, (_event, filename) => this.onFsEvent(filename));
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.watcher.on("error", (err) => {
        console.warn("Library watcher failed, falling back to periodic rescans:", err);
        this.watcher?.close();
        this.watcher = null;
        this.startPolling();
      });
    } catch (err) {
      console.warn("Recursive watching unavailable, falling back to periodic rescans:", err);
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.rescan(), this.opts.pollIntervalMs);
    this.emitStatus(true);
  }

  private onFsEvent(filename: string | Buffer | null): void {
    if (filename === null) {
      void this.rescan(); // event without a path: resync everything
      return;
    }
    const rel = String(filename).split(sep).join("/");
    if (!rel || isIgnoredRelPath(rel)) return;
    const prev = this.debounceTimers.get(rel);
    if (prev) clearTimeout(prev);
    const gen = this.generation;
    this.debounceTimers.set(
      rel,
      setTimeout(() => {
        this.debounceTimers.delete(rel);
        if (gen !== this.generation) return;
        this.reconcilePath(rel).catch((err) => console.warn(`Failed to reconcile ${rel}:`, err));
      }, this.opts.debounceMs),
    );
  }

  /** Bring the index in line with whatever is (or isn't) at `rel` now. */
  async reconcilePath(rel: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    const abs = join(root, rel);
    const st = await stat(abs).catch(() => null);

    if (!st) {
      if (this.index.get(rel)) this.dropFile(rel);
      else for (const f of this.index.filesUnder(rel)) this.dropFile(f.relPath);
      return;
    }
    if (st.isDirectory()) {
      for await (const f of walkBooks(root, rel)) await this.reconcileFile(f, { waitStable: true });
      for (const f of this.index.filesUnder(rel)) {
        if (!(await stat(join(root, f.relPath)).catch(() => null))) this.dropFile(f.relPath);
      }
      return;
    }
    if (!st.isFile()) return;
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const detected = detectFormat(name);
    if (detected) await this.reconcileFile({ abs, rel, stat: st, detected }, { waitStable: true });
  }

  // ---- per-file processing ---------------------------------------------------

  private moveKey(st: Pick<Stats, "ino" | "size" | "mtimeMs">): string {
    return `${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  }

  /** Serialize work on one path (watcher and scan may race on the same file). */
  private async withPathLock<T>(rel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.pathLocks.get(rel) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.pathLocks.set(rel, settled);
    try {
      return await run;
    } finally {
      if (this.pathLocks.get(rel) === settled) this.pathLocks.delete(rel);
    }
  }

  private async reconcileFile(f: WalkedFile, { waitStable }: { waitStable: boolean }): Promise<LinkResult | null> {
    const gen = this.generation;
    const unchanged = (s: Stats) => {
      const existing = this.index.get(f.rel);
      return !!existing && existing.size === s.size && existing.mtimeMs === Math.trunc(s.mtimeMs);
    };
    if (unchanged(f.stat)) return null;

    let st = f.stat;
    const moved = this.takeRecentlyRemoved(st) ?? (await this.takeMovedFrom(f.rel, st));
    if (!moved && waitStable) {
      const stable = await this.waitUntilStable(join(this.root!, f.rel), st);
      if (!stable || gen !== this.generation) return null;
      st = stable;
    }

    return this.withPathLock(f.rel, async () => {
      if (gen !== this.generation || unchanged(st)) return null;
      const previous = this.index.remove(f.rel);
      const result = await this.linker.link({
        abs: f.abs,
        rel: f.rel,
        size: st.size,
        mtimeMs: Math.trunc(st.mtimeMs),
        ino: st.ino,
        detected: f.detected,
        hash: moved ?? undefined,
      });
      if (gen !== this.generation) {
        this.index.remove(f.rel);
        return null;
      }
      this.retention.fileAdded(result.file.bookId);
      if (previous && previous.bookId !== result.file.bookId) this.retention.fileRemoved(previous.bookId);
      this.deps.events.libraryChanged(previous ? [previous.bookId, result.file.bookId] : [result.file.bookId]);
      this.emitStatus();
      return result;
    });
  }

  private async waitUntilStable(abs: string, initial: Stats): Promise<Stats | null> {
    let prev = initial;
    for (let i = 0; i < 150; i++) {
      await sleep(this.opts.stableMs);
      const cur = await stat(abs).catch(() => null);
      if (!cur || !cur.isFile()) return null;
      if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) return cur;
      prev = cur;
    }
    return null;
  }

  private dropFile(rel: string): IndexedFile | undefined {
    const removed = this.index.remove(rel);
    if (!removed) return undefined;
    const now = Date.now();
    this.recentlyRemoved.set(this.moveKey({ ino: removed.ino, size: removed.size, mtimeMs: removed.mtimeMs }), {
      hash: removed.hash,
      at: now,
    });
    for (const [k, v] of this.recentlyRemoved) if (now - v.at > MOVE_MEMORY_MS) this.recentlyRemoved.delete(k);
    this.retention.fileRemoved(removed.bookId);
    this.deps.events.libraryChanged([removed.bookId]);
    this.emitStatus();
    return removed;
  }

  /** The new path of a move was seen before the old path's removal: drop the old entry, reuse its hash. */
  private async takeMovedFrom(rel: string, st: Stats): Promise<string | null> {
    const old = this.index.findByInode(st.ino, st.size, st.mtimeMs);
    if (!old || old.relPath === rel) return null;
    if (await stat(join(this.root!, old.relPath)).catch(() => null)) return null; // hard link / copy, not a move
    this.dropFile(old.relPath);
    return this.takeRecentlyRemoved(st);
  }

  private takeRecentlyRemoved(st: Stats): string | null {
    const key = this.moveKey(st);
    const hit = this.recentlyRemoved.get(key);
    if (!hit) return null;
    this.recentlyRemoved.delete(key);
    return Date.now() - hit.at <= MOVE_MEMORY_MS ? hit.hash : null;
  }

  private emitStatus(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStatusEmit < 250) return;
    this.lastStatusEmit = now;
    this.deps.events.emit({ type: "library.status", status: this.status() });
  }
}
