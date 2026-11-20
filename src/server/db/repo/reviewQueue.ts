import type { Database } from "bun:sqlite";
import type { MetadataCandidate } from "../../../shared/types.ts";

/** Lookup results waiting for the user, one entry per book. */

export interface ReviewRow {
  readonly bookId: number;
  readonly candidates: readonly MetadataCandidate[];
  readonly createdAt: string;
}

/** Every entry, oldest first. */
export function list(db: Database): ReviewRow[] {
  const rows = db.query("SELECT book_id, payload, created_at FROM review_queue ORDER BY created_at, book_id").all() as {
    book_id: number;
    payload: string;
    created_at: string;
  }[];
  return rows.map((r) => ({ bookId: r.book_id, candidates: JSON.parse(r.payload) as MetadataCandidate[], createdAt: r.created_at }));
}

export function bookIds(db: Database): number[] {
  return (db.query("SELECT book_id FROM review_queue").all() as { book_id: number }[]).map((r) => r.book_id);
}

export function count(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM review_queue").get() as { n: number }).n;
}

/** Store (or replace) a book's candidates. */
export function put(db: Database, bookId: number, candidates: readonly MetadataCandidate[]): void {
  db.query(
    `INSERT INTO review_queue (book_id, payload) VALUES (?, ?)
     ON CONFLICT(book_id) DO UPDATE SET payload = excluded.payload, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(bookId, JSON.stringify(candidates));
}

/** Whether there was an entry to remove. */
export function remove(db: Database, bookId: number): boolean {
  return db.query("DELETE FROM review_queue WHERE book_id = ?").run(bookId).changes > 0;
}
