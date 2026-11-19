import type { AppContext } from "../app.ts";

let failing = false;

/**
 * `/api/health` (the `health_path` in `bookshelf serviceman-info`): 200 while the server and its database work,
 * 503 otherwise. ServiceMan polls it every few seconds, so it only runs a trivial query. The library's state (no root
 * yet, scanning) doesn't count: that's not the service being down.
 */
export function health(app: AppContext): Response {
  const headers = { "Cache-Control": "no-store" };
  try {
    app.db.query("SELECT 1").get();
    failing = false;
    return Response.json({ ok: true }, { headers });
  } catch (err) {
    // Log the cause once when the check starts failing, not on every poll.
    if (!failing) console.error("Health check failed:", err);
    failing = true;
    return Response.json({ ok: false, error: "database unavailable" }, { status: 503, headers });
  }
}
