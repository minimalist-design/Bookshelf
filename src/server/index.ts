import index from "../web/index.html";
import { createApp } from "./app.ts";
import { apiRoutes } from "./api/router.ts";

const app = createApp();
const EVENTS_TOPIC = "events";

const server = Bun.serve({
  port: app.config.port,
  hostname: app.config.hostname,
  maxRequestBodySize: app.config.maxUploadBytes,
  idleTimeout: 255, // seconds; slow uploads of large files
  routes: {
    ...apiRoutes(app),
    "/ws": (req, srv) =>
      srv.upgrade(req) ? undefined : new Response("WebSocket upgrade expected", { status: 400 }),
    // SPA: every other path serves the React app.
    "/*": index,
  },
  websocket: {
    open(ws) {
      ws.subscribe(EVENTS_TOPIC);
      ws.send(JSON.stringify({ type: "library.status", status: app.library.status() }));
    },
    message() {
      /* server → client only */
    },
  },
  development: app.config.isProduction ? false : { hmr: true, console: true },
});

app.events.subscribe((event) => server.publish(EVENTS_TOPIC, JSON.stringify(event)));

console.log(`Bookshelf running at ${server.url}`);
console.log(`Data directory: ${app.config.dataDir}`);
const root = app.libraryRoot();
console.log(`Library root: ${root ?? "(not configured — open the web UI to choose one)"}`);
app.library.open(root).catch((err) => console.error("Library scan failed:", err));

const shutdown = async () => {
  await app.library.close();
  app.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
