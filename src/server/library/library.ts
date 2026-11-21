import type { Database } from "bun:sqlite";
import { existsSync, rmSync, type Stats } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import * as hashCacheRepo from "../db/repo/hashCache.ts";
import type { EventBus } from "../events.ts";
import type { Extractor } from "../extract/index.ts";
import { FORMAT_METADATA_RANK } from "../extract/merge.ts";
import type { LibraryState, LibraryStatus } from "../../shared/types.ts";
import { createLibraryIndex, type IndexedFile, type LibraryIndex } from "./libraryIndex.ts";
import { createLinker, type Linker, type LinkerDeps, type LinkResult } from "./linker.ts";
import { createRetention, type Retention } from "./retention.ts";
import { INCOMING_DIR } from "./paths.ts";
import { walkBooks, type WalkedFile } from "./walk.ts";

export interface LibraryOptions {
  scanConcurrency: number;
}

export const DEFAULT_LIBRARY_OPTIONS: LibraryOptions = {
  scanConcurrency: 4,
};

export interface LibraryDeps {
  db: Database;
  extract: Extractor;
  events: EventBus;
  onLinkedNew?: LinkerDeps["onLinkedNew"];
  /** Rows deleted by the retention rule (e.g. to remove cover files). */
  onBooksDeleted?: (bookIds: number[]) => void;
}

/**
 * Owns the view of the library directory: full scans (at startup, when the root changes and on request),
 * linking files to metadata and the retention rule. Changes made outside Bookshelf are seen at the next scan.
 */
export interface Library {
  readonly index: LibraryIndex;
  readonly linker: Linker;
  readonly retention: Retention;
  readonly rootPath: string | null;
  status(): LibraryStatus;
  /** Switch to `root` (or none): clears the index and starts a full scan. */
  open(root: string | null): Promise<void>;
  close(): Promise<void>;
  /** Resolves once no full scan is running (the index is complete). */
  whenReady(): Promise<void>;
  /** Full reconciliation of the index with the disk. Concurrent calls share one run. */
  rescan(): Promise<void>;
  /** A file of `bookId` was indexed by an import. */
  fileAdded(bookId: number): void;
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

export function createLibrary(deps: LibraryDeps, options: Partial<LibraryOptions> = {}): Library {
  const opts: LibraryOptions = { ...DEFAULT_LIBRARY_OPTIONS, ...options };
  const index = createLibraryIndex();
  const retention = createRetention({
    db: deps.db,
    index,
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
  });

  let root: string | null = null;
  let state: LibraryState = "no-root";
  let message: string | null = null;
  /** The last full scan found no files while metadata exists (see Retention.reconcile). */
  let emptyGuard = false;
  let scanProgress: { done: number; total: number } | null = null;
  /** Bumped by close(): work started under an older generation stops. */
  let generation = 0;
  let scanPromise: Promise<void> | null = null;
  let lastStatusEmit = 0;

  const status = (): LibraryStatus => ({
    state,
    root,
    scan: scanProgress,
    fileCount: index.size,
    bookCount: index.bookIds().length,
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

  const fileAdded = (_bookId: number) => {
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
      message = `Library directory is not accessible: ${scanRoot} (rescan once it is back)`;
      emitStatus(true);
      return;
    }
    if (gen !== generation) return; // closed or re-opened meanwhile

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
          await reconcileFile(f);
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

  // ---- per-file processing ---------------------------------------------------

  const reconcileFile = async (f: WalkedFile): Promise<LinkResult | null> => {
    const gen = generation;
    if (isUnchanged(index.get(f.rel), f.stat)) return null;
    const moved = takeMovedFrom(f.rel, f.stat);
    const previous = index.remove(f.rel);
    const result = await linker.link({
      abs: f.abs,
      rel: f.rel,
      size: f.stat.size,
      mtimeMs: Math.trunc(f.stat.mtimeMs),
      ino: f.stat.ino,
      detected: f.detected,
      hash: moved ?? undefined,
    });
    if (gen !== generation) {
      index.remove(f.rel);
      return null;
    }
    fileAdded(result.file.bookId);
    deps.events.libraryChanged(previous ? [previous.bookId, result.file.bookId] : [result.file.bookId]);
    emitStatus();
    return result;
  };

  /** Drop a file from the index; the retention rule runs at the end of the scan. */
  const dropFile = (rel: string): IndexedFile | undefined => {
    const removed = index.remove(rel);
    if (!removed) return undefined;
    deps.events.libraryChanged([removed.bookId]);
    emitStatus();
    return removed;
  };

  /** A file moved since the last scan (same inode, old path gone): drop the old entry and reuse its hash. */
  const takeMovedFrom = (rel: string, st: Stats): string | null => {
    const old = index.findByInode(st.ino, st.size, st.mtimeMs);
    if (!old || old.relPath === rel || existsSync(join(root!, old.relPath))) return null; // not moved, or a hard link / copy
    dropFile(old.relPath);
    return old.hash;
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
      await rescan();
    },
    close,
    async whenReady() {
      while (scanPromise) await scanPromise;
    },
    rescan,
    fileAdded,
  };
}
