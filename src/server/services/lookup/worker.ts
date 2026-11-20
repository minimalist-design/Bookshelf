/**
 * Bulk lookups in the background: queued books are looked up one at a time at the services'
 * allowed pace, behind interactive requests, and their candidates land in the review queue. The
 * queue is stored in the database; when a service rate-limits us the worker pauses until it
 * accepts requests again.
 */
import type { AppContext } from "../../app.ts";
import * as bookRepo from "../../db/repo/books.ts";
import * as jobRepo from "../../db/repo/lookupJobs.ts";
import * as reviewRepo from "../../db/repo/reviewQueue.ts";
import { RateLimitedError, serviceName } from "../../sources/http.ts";
import type { LookupJobDto, LookupQueueStatus } from "../../../shared/types.ts";
import { findCandidates, reviewCount } from "./lookup.ts";

export type WorkerDeps = Pick<AppContext, "db" | "library" | "events" | "http" | "config" | "isbndbStore">;

export interface LookupWorker {
  /** Resume a run interrupted by a restart (the worker waits for the library scan). */
  start(): void;
  /** Queue books for background lookup; returns the new status. */
  enqueue(ids: readonly number[]): LookupQueueStatus;
  /** Drop the books still waiting (the one being looked up finishes). */
  cancel(): LookupQueueStatus;
  /** Queue the books of this run whose lookup failed again. */
  retryFailed(): LookupQueueStatus;
  status(): LookupQueueStatus;
  /** Tell clients the current status (after the queue or the review queue changed). */
  emitStatus(): void;
  /** The lookup job of each book (null: none, e.g. never queued or cancelled). */
  jobs(ids: readonly number[]): Record<number, LookupJobDto | null>;
  /** Waits for the background worker to finish (tests). */
  idle(): Promise<void>;
  /** Stop the worker (shutdown); pending books stay queued for the next start. */
  stop(): void;
}

/** Books whose lookup time feeds the time-left estimate. */
const ETA_WINDOW = 20;
/** How often a worker waiting for the library checks again. */
const LIBRARY_POLL_MS = 2000;

/** Time left: the average time per book for every pending one, plus what's left of a pause; null without data. */
export function etaSeconds(durations: readonly number[], pending: number, pausedForMs: number): number | null {
  if (!pending || !durations.length) return null;
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return Math.round((avg * pending + pausedForMs) / 1000);
}

export function createLookupWorker(deps: WorkerDeps): LookupWorker {
  const { db, library, http, events } = deps;
  /** The background worker is active (it may be paused or waiting for the library). */
  let working = false;
  let stopped = false;
  let pause: { until: number; by: string } | null = null;
  let waitingForLibrary = false;
  let currentBookId: number | null = null;
  /** Cuts the current rest short. */
  let wake: (() => void) | null = null;
  /** Milliseconds per looked-up book in this run (most recent last). */
  let durations: number[] = [];

  const status = (): LookupQueueStatus => {
    const counts = jobRepo.stateCounts(db, jobRepo.currentRun(db));
    const pending = counts.pending;
    const now = Date.now();
    const activePause = pause && pause.until > now ? pause : null;
    return {
      running: pending > 0,
      pending,
      done: counts.done + counts.no_match + counts.failed,
      failed: counts.failed,
      noMatch: counts.no_match,
      reviewCount: reviewCount(deps),
      pausedUntil: activePause ? new Date(activePause.until).toISOString() : null,
      pausedBy: activePause?.by ?? null,
      waitingForLibrary: pending > 0 && waitingForLibrary,
      etaSeconds: etaSeconds(durations, pending, activePause ? activePause.until - now : 0),
      currentBookId: pending > 0 ? currentBookId : null,
    };
  };

  const emitStatus = () => events.emit({ type: "lookup.status", status: status() });

  /** Sleep that cancel()/stop() can cut short. */
  const rest = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      wake = done;
    });

  const drain = async (): Promise<void> => {
    if (working || stopped) return;
    working = true;
    try {
      while (!stopped) {
        const job = jobRepo.nextPending(db);
        if (!job) break;

        const ready = library.status().state === "ready";
        if (ready !== !waitingForLibrary) {
          waitingForLibrary = !ready;
          emitStatus();
        }
        if (!ready) {
          await rest(LIBRARY_POLL_MS);
          continue;
        }

        const book = library.index.hasBook(job.bookId) ? bookRepo.get(db, job.bookId) : null;
        if (!book) {
          jobRepo.remove(db, job.id);
          continue;
        }
        const started = Date.now();
        currentBookId = book.id;
        emitStatus();
        try {
          const { candidates, errors } = await http.background(() => findCandidates(deps, book, {}, true));
          if (candidates.length) {
            reviewRepo.put(db, book.id, candidates);
            jobRepo.finish(db, job.id, "done");
          } else if (errors.length) jobRepo.finish(db, job.id, "failed", errors.join("; "));
          else jobRepo.finish(db, job.id, "no_match");
          durations = [...durations, Date.now() - started].slice(-ETA_WINDOW);
        } catch (err) {
          if (err instanceof RateLimitedError) {
            // Not the book's fault: keep it first in line and wait until the service accepts requests.
            pause = { until: err.retryAt, by: serviceName(err.host) };
            console.warn(`Metadata lookups paused until ${new Date(err.retryAt).toISOString()}: ${err.message}`);
            emitStatus();
            await rest(err.retryAt - Date.now());
            pause = null;
            emitStatus();
            continue;
          }
          jobRepo.finish(db, job.id, "failed", err instanceof Error ? err.message : String(err));
        } finally {
          currentBookId = null;
        }
        emitStatus();
      }
    } finally {
      working = false;
      pause = null;
      waitingForLibrary = false;
      currentBookId = null;
      if (!stopped) emitStatus();
    }
  };

  /** Start the worker if needed and report the new status. */
  const kick = (): LookupQueueStatus => {
    void drain();
    emitStatus();
    return status();
  };

  return {
    start() {
      if (jobRepo.countPending(db) > 0) void drain();
    },
    enqueue(ids) {
      // A new run starts when the previous one is over (its jobs stay readable for a day).
      if (jobRepo.enqueue(db, ids.filter((id) => library.index.hasBook(id)))) durations = [];
      return kick();
    },
    cancel() {
      jobRepo.cancelPending(db);
      wake?.();
      emitStatus();
      return status();
    },
    retryFailed() {
      jobRepo.retryFailed(db, jobRepo.currentRun(db));
      return kick();
    },
    status,
    emitStatus,
    jobs: (ids) => jobRepo.jobsOf(db, ids),
    async idle() {
      while (working) await Bun.sleep(20);
    },
    stop() {
      stopped = true;
      wake?.();
    },
  };
}
