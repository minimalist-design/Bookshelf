import index from "../web/index.html";
import { createApp } from "./app.ts";
import { apiRoutes } from "./api/router.ts";
import { prepareConfigLibraryRoot } from "./api/settings.ts";
import { configPath, CURRENT_VERSION, fileVersion, tilde, writeConfigPort } from "./configFile.ts";
import { listen } from "./listen.ts";

const version = fileVersion();
if (version === null) {
  console.log(`No config file at ${tilde(configPath())}; using the defaults (see \`bookshelf config template\`)`);
} else if (version < CURRENT_VERSION) {
  console.warn(
    `Config ${tilde(configPath())} is version ${version}, current is ${CURRENT_VERSION}: run \`bookshelf config update\` to add the new settings`,
  );
}

const app = createApp();
prepareConfigLibraryRoot(app);
const EVENTS_TOPIC = "events";

// The port is the config's; without one (first start) a free one in 20000–20999 is picked and saved in the config.
const { server, port, assigned } = listen(
  app.config.port,
  (port) =>
    Bun.serve({
      port,
      hostname: app.config.hostname,
      // Bun turns SO_REUSEPORT on by default in production, which lets a second process bind a port that's in use:
      // the port scan would then never see a taken port, and two services could share one.
      reusePort: false,
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
    }),
  tilde(configPath()),
);
if (assigned) {
  try {
    writeConfigPort(configPath(), port);
    console.log(`Assigned port ${port}; saved in ${tilde(configPath())}, where it stays from now on`);
  } catch (err) {
    console.error(`Assigned port ${port}, but couldn't save it: ${err instanceof Error ? err.message : err}`);
  }
}

app.events.subscribe((event) => server.publish(EVENTS_TOPIC, JSON.stringify(event)));

console.log(`Bookshelf running at ${server.url}`);
console.log(`Config: ${configPath()}`);
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
