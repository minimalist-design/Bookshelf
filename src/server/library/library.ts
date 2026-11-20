import type { Database } from "bun:sqlite";
import { rmSync, watch, type FSWatcher, type Stats } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import * as bookRepo from "../db/repo/books.ts";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Extractor } from "../extract/index.ts";
import { FORMAT_METADATA_RANK } from "../extract/merge.ts";
import type { RawMetadata } from "../metadata/types.ts";
import { detectFormat } from "../naming/formats.ts";
import type { LibraryState, LibraryStatus } from "../../shared/types.ts";
import { createLibraryIndex, inodeKey, type IndexedFile, type LibraryIndex } from "./libraryIndex.ts";
import { createLinker, type Linker, type LinkerDeps, type LinkResult } from "./linker.ts";
import { createRetention, type Retention } from "./retention.ts";
import { INCOMING_DIR } from "./paths.ts";
import { isIgnoredRelPath, walkBooks, type WalkedFile } from "./walk.ts";
import { UnavailableError } from "../api/http.ts";

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
  db: Database;
  extract: Extractor;
  events: EventBus;
  onLinkedNew?: LinkerDeps["onLinkedNew"];
  canonicalize?: LinkerDeps["canonicalize"];
  /** Rows deleted by the retention rule (e.g. to remove cover files). */
  onBooksDeleted?: (bookIds: number[]) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOVE_MEMORY_MS = 60_000;

/**
 * Owns the live view of the library directory: full scans, the recursive watcher,
 * linking files to metadata and the retention rule.
 */
export interface Library {
  readonly index: LibraryIndex;
  readonly linker: Linker;
  readonly retention: Retention;
  readonly rootPath: string | null;
  status(): LibraryStatus;
  /** Switch to `root` (or none): stops watching, clears the index, starts watcher + full scan. */
  open(root: string | null): Promise<void>;
  close(): Promise<void>;
  /** Resolves once no full scan is running (the index is complete). */
  whenReady(): Promise<void>;
  /** Full reconciliation of the index with the disk. Concurrent calls share one run. */
  rescan(): Promise<void>;
  /** A file of `bookId` was indexed (watcher or import). */
  fileAdded(bookId: number): void;
  /** Bring the index in line with whatever is (or isn't) at `rel` now. */
  reconcilePath(rel: string): Promise<void>;
}

/** Whether the index already holds this exact version of the file. */
export function isUnchanged(existing: IndexedFile | undefined, st: Pick<Stats, "size" | "mtimeMs">): boolean {
  return !!existing && existing.size === st.size && existing.mtimeMs === Math.trunc(st.mtimeMs);
}

/** Scan order: best metadata sources first, so multi-format books are usually created from their richest file. */
export function scanOrder<T extends { detected: { format: keyof typeof FORMAT_METADATA_RANK } }>(found: readonly T[]): T[] {
  return found.toSorted((a, b) => FORMAT_METADATA_RANK[a.detected.format] - FORMAT_METADATA_RANK[b.detected.format]);
}

/** Status events are throttled to one per 250 ms unless forced (state changes). */
export function shouldEmitStatus(force: boolean, now: number, lastEmit: number): boolean {
  return force || now - lastEmit >= STATUS_THROTTLE_MS;
}

const STATUS_THROTTLE_MS = 250;
const moveKey = (st: Pick<Stats, "ino" | "size" | "mtimeMs">) => inodeKey(st.ino, st.size, st.mtimeMs);

export function createLibrary(deps: LibraryDeps, options: Partial<LibraryOptions> = {}): Library {
  const opts: LibraryOptions = { ...DEFAULT_LIBRARY_OPTIONS, ...options };
  const index = createLibraryIndex();
  const retention = createRetention({
    db: deps.db,
    index,
    graceMs: opts.graceMs,
    onDeleted: (ids) => {
      deps.onBooksDeleted?.(ids);
      deps.events.libraryChanged(ids);
    },
  });
  const linker = createLinker({
    db: deps.db,
    extract: deps.extract,
    index,
    onLinkedNew: deps.onLinkedNew,
    canonicalize: deps.canonicalize,
    isKnownAuthor: (name) => bookRepo.hasAuthor(deps.db, name),
  });

  let root: string | null = null;
  let state: LibraryState = "no-root";
  let message: string | null = null;
  /** The last full scan found no files while metadata exists (see Retention.reconcile). */
  let emptyGuard = false;
  let scanProgress: { done: number; total: number } | null = null;
  /** Bumped by close(): work started under an older generation stops. */
  let generation = 0;
  let watcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pathLocks = new Map<string, Promise<unknown>>();
  /** Files that just disappeared, keyed by inode+size+mtime, so a move can reuse the hash. */
  const recentlyRemoved = new Map<string, { hash: string; at: number }>();
  let scanPromise: Promise<void> | null = null;
  let lastStatusEmit = 0;

  const status = (): LibraryStatus => ({
    state,
    root,
    scan: scanProgress,
    fileCount: index.size,
    bookCount: index.bookIds().length,
    watching: watcher !== null,
    message,
  });

  const emitStatus = (force = false) => {
    const now = Date.now();
    if (!shouldEmitStatus(force, now, lastStatusEmit)) return;
    lastStatusEmit = now;
    deps.events.emit({ type: "library.status", status: status() });
  };

  const close = async () => {
    generation++;
    watcher?.close();
    watcher = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    retention.stop();
    index.clear();
    scanProgress = null;
    scanPromise = null;
  };

  const rescan = (): Promise<void> => {
    scanPromise ??= fullScan().finally(() => {
      scanPromise = null;
    });
    return scanPromise;
  };

  const fileAdded = (bookId: number) => {
    retention.fileAdded(bookId);
    if (!emptyGuard) return;
    // The library is evidently there after all: drop the warning and reconcile properly.
    emptyGuard = false;
    message = null;
    emitStatus(true);
    void rescan();
  };

  // ---- full scan ------------------------------------------------------------

  const fullScan = async (): Promise<void> => {
    const gen = generation;
    const scanRoot = root;
    if (!scanRoot) return;

    try {
      await access(scanRoot, constants.R_OK | constants.X_OK);
    } catch {
      if (gen !== generation) return;
      state = "unavailable";
      message = `Library directory is not accessible: ${scanRoot}`;
      startPolling(); // recover automatically when it comes back (e.g. drive mounted)
      emitStatus(true);
      return;
    }
    if (gen !== generation) return; // closed or re-opened meanwhile
    if (!watcher) startWatching(scanRoot);

    state = "scanning";
    message = null;
    emptyGuard = false;
    const walked: WalkedFile[] = [];
    for await (const f of walkBooks(scanRoot)) {
      if (gen !== generation) return;
      walked.push(f);
    }
    const found = scanOrder(walked);
    const progress = { done: 0, total: found.length };
    scanProgress = progress;
    emitStatus(true);

    // A small pool of workers takes the files in order.
    let next = 0;
    const worker = async () => {
      while (next < found.length && gen === generation) {
        const f = found[next++]!;
        try {
          await reconcileFile(f, { waitStable: false });
        } catch (err) {
          console.warn(`Failed to process ${f.rel}:`, err);
        }
        progress.done++;
        emitStatus();
      }
    };
    await Promise.all(Array.from({ length: opts.scanConcurrency }, worker));
    if (gen !== generation) return;

    // Files indexed earlier that no longer exist (rescans).
    const seen = new Set(found.map((f) => f.rel));
    for (const f of [...index.allFiles()].filter((f) => !seen.has(f.relPath))) dropFile(f.relPath);
    hashCacheRepo.prune(deps.db, new Set(found.map((f) => f.abs)));
    if (retention.reconcile(found.length).skipped) {
      emptyGuard = true;
      message = "Library appears empty; kept all metadata (is the drive mounted?)";
    }

    state = "ready";
    scanProgress = null;
    emitStatus(true);
    deps.events.libraryChanged([]);
  };

  // ---- watcher --------------------------------------------------------------

  const startWatching = (watchRoot: string) => {
    try {
      watcher = watch(watchRoot, { recursive: true }, (_event, filename) => onFsEvent(filename));
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      watcher.on("error", (err) => {
        console.warn("Library watcher failed, falling back to periodic rescans:", err);
        watcher?.close();
        watcher = null;
        startPolling();
      });
    } catch (err) {
      console.warn("Recursive watching unavailable, falling back to periodic rescans:", err);
      startPolling();
    }
  };

  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => void rescan(), opts.pollIntervalMs);
    emitStatus(true);
  };

  const onFsEvent = (filename: string | Buffer | null) => {
    if (filename === null) {
      void rescan(); // event without a path: resync everything
      return;
    }
    const rel = String(filename).split(sep).join("/");
    if (!rel || isIgnoredRelPath(rel)) return;
    clearTimeout(debounceTimers.get(rel));
    const gen = generation;
    debounceTimers.set(
      rel,
      setTimeout(() => {
        debounceTimers.delete(rel);
        if (gen !== generation) return;
        reconcilePath(rel).catch((err) => console.warn(`Failed to reconcile ${rel}:`, err));
      }, opts.debounceMs),
    );
  };

  const reconcilePath = async (rel: string): Promise<void> => {
    if (!root) return;
    const base = root;
    const abs = join(base, rel);
    const st = await stat(abs).catch(() => null);

    if (!st) {
      if (index.get(rel)) dropFile(rel);
      else for (const f of index.filesUnder(rel)) dropFile(f.relPath);
      return;
    }
    if (st.isDirectory()) {
      for await (const f of walkBooks(base, rel)) await reconcileFile(f, { waitStable: true });
      for (const f of index.filesUnder(rel)) {
        if (!(await stat(join(base, f.relPath)).catch(() => null))) dropFile(f.relPath);
      }
      return;
    }
    if (!st.isFile()) return;
    const detected = detectFormat(rel.slice(rel.lastIndexOf("/") + 1));
    if (detected) await reconcileFile({ abs, rel, stat: st, detected }, { waitStable: true });
  };

  // ---- per-file processing ---------------------------------------------------

  /** Serialize work on one path (watcher and scan may race on the same file). */
  const withPathLock = async <T>(rel: string, fn: () => Promise<T>): Promise<T> => {
    const prev = pathLocks.get(rel) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    pathLocks.set(rel, settled);
    try {
      return await run;
    } finally {
      if (pathLocks.get(rel) === settled) pathLocks.delete(rel);
    }
  };

  const reconcileFile = async (f: WalkedFile, { waitStable }: { waitStable: boolean }): Promise<LinkResult | null> => {
    const gen = generation;
    if (isUnchanged(index.get(f.rel), f.stat)) return null;

    const moved = takeRecentlyRemoved(f.stat) ?? (await takeMovedFrom(f.rel, f.stat));
    const st = !moved && waitStable ? await waitUntilStable(join(root!, f.rel), f.stat) : f.stat;
    if (!st || gen !== generation) return null;

    return withPathLock(f.rel, async () => {
      if (gen !== generation || isUnchanged(index.get(f.rel), st)) return null;
      const previous = index.remove(f.rel);
      const result = await linker.link({
        abs: f.abs,
        rel: f.rel,
        size: st.size,
        mtimeMs: Math.trunc(st.mtimeMs),
        ino: st.ino,
        detected: f.detected,
        hash: moved ?? undefined,
      });
      if (gen !== generation) {
        index.remove(f.rel);
        return null;
      }
      fileAdded(result.file.bookId);
      if (previous && previous.bookId !== result.file.bookId) retention.fileRemoved(previous.bookId);
      deps.events.libraryChanged(previous ? [previous.bookId, result.file.bookId] : [result.file.bookId]);
      emitStatus();
      return result;
    });
  };

  /** The file's stat once its size and mtime stop changing; null if it vanished or never settled. */
  const waitUntilStable = async (abs: string, initial: Stats): Promise<Stats | null> => {
    let prev = initial;
    for (let i = 0; i < 150; i++) {
      await sleep(opts.stableMs);
      const cur = await stat(abs).catch(() => null);
      if (!cur || !cur.isFile()) return null;
      if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) return cur;
      prev = cur;
    }
    return null;
  };

  const dropFile = (rel: string): IndexedFile | undefined => {
    const removed = index.remove(rel);
    if (!removed) return undefined;
    const now = Date.now();
    recentlyRemoved.set(moveKey(removed), { hash: removed.hash, at: now });
    for (const [k, v] of recentlyRemoved) if (now - v.at > MOVE_MEMORY_MS) recentlyRemoved.delete(k);
    retention.fileRemoved(removed.bookId);
    deps.events.libraryChanged([removed.bookId]);
    emitStatus();
    return removed;
  };

  /** The new path of a move was seen before the old path's removal: drop the old entry, reuse its hash. */
  const takeMovedFrom = async (rel: string, st: Stats): Promise<string | null> => {
    const old = index.findByInode(st.ino, st.size, st.mtimeMs);
    if (!old || old.relPath === rel) return null;
    if (await stat(join(root!, old.relPath)).catch(() => null)) return null; // hard link / copy, not a move
    dropFile(old.relPath);
    return takeRecentlyRemoved(st);
  };

  const takeRecentlyRemoved = (st: Stats): string | null => {
    const key = moveKey(st);
    const hit = recentlyRemoved.get(key);
    if (!hit) return null;
    recentlyRemoved.delete(key);
    return Date.now() - hit.at <= MOVE_MEMORY_MS ? hit.hash : null;
  };

  return {
    index,
    linker,
    retention,
    get rootPath() {
      return root;
    },
    status,
    async open(next) {
      await close();
      root = next;
      state = next ? "scanning" : "no-root";
      emitStatus(true);
      if (!next) return;
      // Leftovers of uploads interrupted by a crash/restart.
      rmSync(join(next, INCOMING_DIR), { recursive: true, force: true });
      await rescan(); // starts the watcher once the root is accessible
    },
    close,
    async whenReady() {
      while (scanPromise) await scanPromise;
    },
    rescan,
    fileAdded,
    reconcilePath,
  };
}

/** Wait for a complete index of an accessible library (bulk operations need to see every book). */
export async function libraryReady(library: Library): Promise<void> {
  if (!library.rootPath) throw new UnavailableError("No library directory is configured");
  await library.whenReady();
  if (library.status().state === "unavailable") throw new UnavailableError("The library directory is not accessible");
}
