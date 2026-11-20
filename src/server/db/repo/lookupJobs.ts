import type { Database } from "bun:sqlite";
import type { LookupJobDto, LookupJobState } from "../../../shared/types.ts";

/** Finished jobs of earlier runs are kept this long (clients read their outcome through /api/lookup/jobs). */
const OLD_JOB_RETENTION = "-1 day";

export const NO_JOBS: Readonly<Record<LookupJobState, number>> = { pending: 0, done: 0, no_match: 0, failed: 0 };

/** The latest run (a batch of queued books); 0 before the first. */
export function currentRun(db: Database): number {
  return (db.query("SELECT COALESCE(MAX(run), 0) AS run FROM lookup_jobs").get() as { run: number }).run;
}

export function countPending(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM lookup_jobs WHERE state = 'pending'").get() as { n: number }).n;
}

/**
 * Queue books. When nothing is pending the previous run is over: a new run starts and finished jobs
 * older than a day are dropped. Returns whether a new run started.
 */
export function enqueue(db: Database, bookIds: readonly number[]): boolean {
  return db.transaction(() => {
    const newRun = countPending(db) === 0;
    const run = currentRun(db) + (newRun ? 1 : 0);
    if (newRun) {
      db.query(`DELETE FROM lookup_jobs WHERE state != 'pending' AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${OLD_JOB_RETENTION}')`).run();
    }
    const add = db.query(
      `INSERT INTO lookup_jobs (book_id, run) VALUES (?, ?)
       ON CONFLICT(book_id) DO UPDATE SET state = 'pending', error = NULL, finished_at = NULL, run = excluded.run,
         id = (SELECT MAX(id) + 1 FROM lookup_jobs)
       WHERE state != 'pending'`,
    );
    for (const id of new Set(bookIds)) add.run(id, run);
    return newRun;
  })();
}

/** Drop every job still waiting. */
export function cancelPending(db: Database): void {
  db.query("DELETE FROM lookup_jobs WHERE state = 'pending'").run();
}

/** Queue the failed jobs of `run` again. */
export function retryFailed(db: Database, run: number): void {
  db.query("UPDATE lookup_jobs SET state = 'pending', error = NULL, finished_at = NULL WHERE state = 'failed' AND run = ?").run(run);
}

/** Jobs per state in `run`, plus every pending job. */
export function stateCounts(db: Database, run: number): Record<LookupJobState, number> {
  const rows = db
    .query("SELECT state, COUNT(*) AS n FROM lookup_jobs WHERE run = ? OR state = 'pending' GROUP BY state")
    .all(run) as { state: LookupJobState; n: number }[];
  return { ...NO_JOBS, ...Object.fromEntries(rows.map((r) => [r.state, r.n])) };
}

/** The job of each book (null: none, e.g. never queued or cancelled). */
export function jobsOf(db: Database, ids: readonly number[]): Record<number, LookupJobDto | null> {
  const rows = ids.length
    ? (db
        .query(
          `SELECT j.book_id, j.state, j.error,
             CASE WHEN j.state = 'pending' THEN (SELECT COUNT(*) FROM lookup_jobs p WHERE p.state = 'pending' AND p.id < j.id) ELSE 0 END AS position
           FROM lookup_jobs j WHERE j.book_id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(ids)) as { book_id: number; state: LookupJobState; error: string | null; position: number }[])
    : [];
  return {
    ...Object.fromEntries(ids.map((id) => [id, null])),
    ...Object.fromEntries(rows.map((r) => [r.book_id, { state: r.state, position: r.position, error: r.error }])),
  };
}

/** The next job to work on, oldest first. */
export function nextPending(db: Database): { id: number; bookId: number } | null {
  const row = db.query("SELECT id, book_id FROM lookup_jobs WHERE state = 'pending' ORDER BY id LIMIT 1").get() as
    | { id: number; book_id: number }
    | null;
  return row && { id: row.id, bookId: row.book_id };
}

export function remove(db: Database, jobId: number): void {
  db.query("DELETE FROM lookup_jobs WHERE id = ?").run(jobId);
}

export function finish(db: Database, jobId: number, state: LookupJobState, error: string | null = null): void {
  db.query("UPDATE lookup_jobs SET state = ?, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(state, error, jobId);
}
