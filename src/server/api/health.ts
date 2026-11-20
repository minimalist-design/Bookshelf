import type { Database } from "bun:sqlite";

/**
 * `/api/health` (the `health_path` in `bookshelf serviceman-info`): 200 while the server and its database work,
 * 503 otherwise. ServiceMan polls it every few seconds, so it only runs a trivial query. The library's state (no root
 * yet, scanning) doesn't count: that's not the service being down.
 *
 * The check remembers whether it is failing, so the cause is logged once when it starts failing, not on every poll.
 */
export function createHealth(db: Database): () => Response {
  let failing = false;
  return () => {
    const headers = { "Cache-Control": "no-store" };
    try {
      db.query("SELECT 1").get();
      failing = false;
      return Response.json({ ok: true }, { headers });
    } catch (err) {
      if (!failing) console.error("Health check failed:", err);
      failing = true;
      return Response.json({ ok: false, error: "database unavailable" }, { status: 503, headers });
    }
  };
}
