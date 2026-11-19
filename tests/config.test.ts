import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config.ts";
import {
  CONFIG_TEMPLATE,
  ConfigError,
  configPath,
  CURRENT_VERSION,
  expandTilde,
  fileVersion,
  readConfigFile,
  updateConfigFile,
} from "../src/server/configFile.ts";

const tmp = mkdtempSync(join(tmpdir(), "bookshelf-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (content?: string) => {
  const p = join(tmp, `c${n++}`, "config.json");
  if (content !== undefined) {
    updateConfigFile(p); // creates the directory
    writeFileSync(p, content);
  }
  return p;
};

describe("config template", () => {
  test("is the file in the repo, and its version is the current one", () => {
    expect(CONFIG_TEMPLATE).toBe(readFileSync(join(import.meta.dir, "..", "config.template.json"), "utf8"));
    expect(JSON.parse(CONFIG_TEMPLATE).version).toBe(CURRENT_VERSION);
    expect(Number.isInteger(CURRENT_VERSION) && CURRENT_VERSION >= 1).toBe(true);
  });

  test("gives the same config as no config file at all", () => {
    const env = { XDG_DATA_HOME: "/xdg/data" };
    const t = loadConfig(JSON.parse(CONFIG_TEMPLATE), env);
    expect(t).toEqual(loadConfig({}, env));
    expect(t).toMatchObject({ dataDir: "/xdg/data/bookshelf", port: 3000, hostname: "0.0.0.0", configLibraryRoot: null });
    expect(t.maxUploadBytes).toBe(16 * 1024 * 1024 * 1024);
  });
});

describe("loading", () => {
  test("paths expand ~", () => {
    expect(expandTilde("~/Books")).toBe(join(homedir(), "Books"));
    expect(expandTilde("/abs/~x")).toBe("/abs/~x");
    const c = loadConfig({ library_root: "~/Books", data_dir: "~/bs-data" });
    expect(c.configLibraryRoot).toBe(join(homedir(), "Books"));
    expect(c.dataDir).toBe(join(homedir(), "bs-data"));
  });

  test("the config path follows XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/bookshelf/config.json");
    expect(configPath({})).toBe(join(homedir(), ".config", "bookshelf", "config.json"));
  });

  test("a missing file means defaults; bad files are errors naming the problem", () => {
    expect(readConfigFile(file())).toEqual({});
    expect(fileVersion(file())).toBeNull();
    expect(() => readConfigFile(file("{ nope"))).toThrow(ConfigError);
    expect(() => readConfigFile(file("[]"))).toThrow(/JSON object/);
    expect(() => readConfigFile(file('{"port": "3000"}'))).toThrow(/"port" must be a number/);
    expect(readConfigFile(file('{"port": 8080, "extra": true}')).port).toBe(8080);
    expect(fileVersion(file('{"port": 8080}'))).toBe(0);
  });
});

describe("config update", () => {
  test("creates a missing file from the template", () => {
    const p = file();
    expect(updateConfigFile(p)).toMatchObject({ created: true, newVersion: CURRENT_VERSION });
    expect(readFileSync(p, "utf8")).toBe(CONFIG_TEMPLATE);
  });

  test("adds missing settings and raises the version without changing anything else", () => {
    const p = file(JSON.stringify({ version: 0, port: 8080, custom: "kept", host: "" }));
    const r = updateConfigFile(p);
    expect(r.oldVersion).toBe(0);
    expect(r.newVersion).toBe(CURRENT_VERSION);
    expect(r.added.sort()).toEqual(["data_dir", "library_root", "max_upload_mb"]);
    const out = JSON.parse(readFileSync(p, "utf8"));
    expect(out).toMatchObject({ version: CURRENT_VERSION, port: 8080, custom: "kept", host: "", max_upload_mb: 16384 });
    expect(updateConfigFile(p)).toMatchObject({ added: [], oldVersion: CURRENT_VERSION, newVersion: CURRENT_VERSION });
  });

  test("never lowers a newer version and leaves an up-to-date file untouched", () => {
    const text = JSON.stringify({ ...JSON.parse(CONFIG_TEMPLATE), version: CURRENT_VERSION + 5 });
    const p = file(text);
    expect(updateConfigFile(p)).toMatchObject({ added: [], newVersion: CURRENT_VERSION + 5 });
    expect(readFileSync(p, "utf8")).toBe(text);
  });
});
