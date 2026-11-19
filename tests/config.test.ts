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
  setPortText,
  updateConfigFile,
  writeConfigPort,
} from "../src/server/configFile.ts";
import { listen, PortError } from "../src/server/listen.ts";
import { SERVICE_INFO_COMMANDS, serviceInfo } from "../src/server/serviceInfo.ts";

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
    expect(t).toMatchObject({ dataDir: "/xdg/data/bookshelf", port: null, hostname: "0.0.0.0", configLibraryRoot: null });
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
    expect(() => readConfigFile(file('{"port": 70000}'))).toThrow(/1–65535/);
    expect(() => readConfigFile(file('{"port": 20000.5}'))).toThrow(/1–65535/);
    expect(loadConfig({ port: 0 }).port).toBeNull();
    expect(loadConfig({ port: 20003 }).port).toBe(20003);
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

describe("port", () => {
  test("writing it changes only that value, keeping the file's formatting", () => {
    const text = '{\n    "version": 1,\n    "port":   0 ,\n    "host": "::1"\n}\n';
    const p = file(text);
    writeConfigPort(p, 20004);
    expect(readFileSync(p, "utf8")).toBe(text.replace("0 ,", "20004 ,"));
  });

  test("a missing key is added; a missing file is created from the template", () => {
    expect(setPortText('{\n  "version": 1\n}\n', 20001)).toBe('{\n  "port": 20001,\n  "version": 1\n}\n');
    expect(JSON.parse(setPortText("{}", 20001)!)).toEqual({ port: 20001 });
    const p = file();
    writeConfigPort(p, 20002);
    expect(readFileSync(p, "utf8")).toBe(CONFIG_TEMPLATE.replace('"port": 0', '"port": 20002'));
  });

  test("anything that would change more than the port is refused", () => {
    // A nested "port" comes first, so a text replacement would hit the wrong place.
    const nested = '{"extra": {"port": 1}, "port": 0}';
    expect(setPortText(nested, 20000)).toBeNull();
    // A quoted "port" inside a string value isn't mistaken for the key.
    expect(JSON.parse(setPortText('{"library_root": "/x/\\"port\\": 1", "port": 0}', 20000)!).port).toBe(20000);
    const p = file(nested);
    expect(() => writeConfigPort(p, 20000)).toThrow(ConfigError);
  });

  const busy = (taken: number[]) => (port: number) => {
    if (taken.includes(port)) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    return `server@${port}`;
  };

  test("without one, the first free port in the range is taken", () => {
    expect(listen(null, busy([]), "cfg")).toEqual({ server: "server@20000", port: 20000, assigned: true });
    expect(listen(null, busy([20000, 20001]), "cfg")).toMatchObject({ port: 20002, assigned: true });
    expect(() => listen(null, busy([5, 6]), "cfg", { first: 5, last: 6 })).toThrow(/every port from 5 to 6/);
  });

  test("a configured port is used as it is, and never moved when it's taken", () => {
    expect(listen(20007, busy([20000]), "cfg")).toEqual({ server: "server@20007", port: 20007, assigned: false });
    expect(() => listen(20007, busy([20007]), "cfg")).toThrow(PortError);
    expect(() => listen(20007, busy([20007]), "cfg")).toThrow(/port 20007 \(set in cfg\)/);
  });

  test("other errors aren't mistaken for a port in use", () => {
    const fail = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(() => listen(null, fail, "cfg")).toThrow(/denied/);
  });

  test("binding for real: a port held by another server is skipped", () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", development: false, fetch: () => new Response("other") });
    const held = other.port!;
    const range = { first: held, last: held + 20 };
    // As in production (where Bun shares ports by default), so `reusePort: false` is what makes this pass.
    const start = (port: number) =>
      Bun.serve({ port, hostname: "127.0.0.1", development: false, reusePort: false, fetch: () => new Response("me") });
    const got = listen(null, start, "cfg", range);
    try {
      expect(got.port).toBeGreaterThan(held);
      expect(() => listen(held, start, "cfg")).toThrow(PortError);
    } finally {
      got.server.stop(true);
      other.stop(true);
    }
  });
});

describe("serviceman-info / caddyman-info", () => {
  test("reports the configured port, or null before the first start", () => {
    const info = serviceInfo(file(CONFIG_TEMPLATE));
    expect(info).toMatchObject({
      serviceman_info: 1,
      caddyman_info: 1,
      name: "bookshelf",
      args: [],
      port: null,
      health_path: "/api/health",
    });
    expect(info.env_file).toBe("~/.secrets/bookshelf.env");
    expect(serviceInfo(file('{"port": 20005}')).port).toBe(20005);
    expect(serviceInfo(file()).port).toBeNull();
  });

  test("both commands print the same JSON; the old name is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "bookshelf-info-"));
    try {
      const run = (cmd: string) =>
        Bun.spawnSync(["bun", join(import.meta.dir, "..", "src/server/index.ts"), cmd], {
          env: { ...process.env, XDG_CONFIG_HOME: home },
        });
      const outs = SERVICE_INFO_COMMANDS.map((cmd) => {
        const p = run(cmd);
        expect(p.exitCode).toBe(0);
        return p.stdout.toString();
      });
      expect(SERVICE_INFO_COMMANDS).toEqual(["serviceman-info", "caddyman-info"]);
      const [first, second] = outs;
      expect(second).toBe(first);
      expect(JSON.parse(first ?? "")).toMatchObject({ serviceman_info: 1, caddyman_info: 1, name: "bookshelf" });
      expect(run("service-info").exitCode).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
