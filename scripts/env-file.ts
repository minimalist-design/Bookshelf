#!/usr/bin/env bun
/**
 * `make install`'s handling of an existing env file. Prints variable names only, never values.
 *
 *   bun scripts/env-file.ts status  TEMPLATE FILE   which template variables FILE lacks
 *   bun scripts/env-file.ts update  TEMPLATE FILE   append them (existing lines stay as they are)
 *   bun scripts/env-file.ts replace TEMPLATE FILE   start over from TEMPLATE, keeping the values FILE sets
 *
 * FILE is rewritten atomically with mode 600, and no backup of it is made (it holds secrets).
 */
import { chmodSync, closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tilde } from "../src/server/configFile.ts";
import { appendMissing, envNames, missingEnvNames, replaceKeepingValues, setEnvNames } from "../src/server/envFile.ts";

const [command, templatePath, filePath] = Bun.argv.slice(2);
if (!command || !templatePath || !filePath || !["status", "update", "replace"].includes(command)) {
  console.error("usage: bun scripts/env-file.ts status|update|replace TEMPLATE FILE");
  process.exit(2);
}

const template = readFileSync(templatePath, "utf8");
const existing = readFileSync(filePath, "utf8");
const missing = missingEnvNames(template, existing);
const shown = tilde(filePath);
const list = (names: string[]) => names.join(", ");

function writeSecret(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(path, 0o600);
}

if (command === "status") {
  console.log(missing.length === 0 ? `${shown} has every variable from ${basename(templatePath)}` : `${shown} lacks ${list(missing)}`);
} else if (command === "update") {
  if (missing.length === 0) {
    console.log(`${shown} already has every variable from ${basename(templatePath)}; nothing to add`);
  } else {
    writeSecret(filePath, appendMissing(template, existing));
    console.log(`added ${list(missing)} to ${shown}`);
  }
} else {
  const present = new Set(setEnvNames(existing));
  const kept = envNames(template).filter((name) => present.has(name));
  writeSecret(filePath, replaceKeepingValues(template, existing));
  console.log(`replaced ${shown} with ${basename(templatePath)}` + (kept.length ? ` (kept the values of ${list(kept)})` : ""));
}
