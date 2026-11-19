#!/usr/bin/env bun
/**
 * `make install`'s Replace: copies the port from the old config (the backup) into the new one, so a service never
 * loses the port it was given on its first start.
 *
 *   bun scripts/carry-port.ts OLD_CONFIG NEW_CONFIG
 */
import { readConfigFile, tilde, writeConfigPort } from "../src/server/configFile.ts";

const [oldPath, newPath] = Bun.argv.slice(2);
if (!oldPath || !newPath) {
  console.error("usage: bun scripts/carry-port.ts OLD_CONFIG NEW_CONFIG");
  process.exit(2);
}
const port = readConfigFile(oldPath).port;
if (port) {
  writeConfigPort(newPath, port);
  console.log(`kept port ${port} in ${tilde(newPath)}`);
}
