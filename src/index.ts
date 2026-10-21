import { createServer } from "node:http";
import { config } from "@/config";

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(config.port, () => {
  console.log(`listening on port ${config.port}`);
});
