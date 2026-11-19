/**
 * The config file, `~/.config/bookshelf/config.json` (`$XDG_CONFIG_HOME` is honoured), and `bookshelf config update`.
 * The template is embedded in the executable; `make install` copies the same file into place.
 */
import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import templateImport from "../../config.template.json" with { type: "text" };

/** The default config, byte for byte as in `config.template.json`. */
export const CONFIG_TEMPLATE = templateImport as unknown as string;

const TEMPLATE = JSON.parse(CONFIG_TEMPLATE) as Record<string, unknown>;

/** The config format this build expects; raised whenever a setting is added or removed (in the template). */
export const CURRENT_VERSION = TEMPLATE.version as number;

/** Settings as written in the file. Missing or empty values fall back to the defaults (see `loadConfig`). */
export interface ConfigFileSettings {
  version?: number;
  /** Library directory; when set it locks the setting in the web UI. Empty: chosen in the UI. */
  library_root?: string;
  /** Database and covers. Empty: `$XDG_DATA_HOME/bookshelf` or `~/.local/share/bookshelf`. */
  data_dir?: string;
  host?: string;
  port?: number;
  max_upload_mb?: number;
}

const TYPES: Record<keyof ConfigFileSettings, "string" | "number"> = {
  version: "number",
  library_root: "string",
  data_dir: "string",
  host: "string",
  port: "number",
  max_upload_mb: "number",
};

export class ConfigError extends Error {}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "bookshelf", "config.json");
}

/** Expands a leading `~` to the home directory. */
export function expandTilde(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Abbreviates a path under the home directory with `~`, for messages. */
export function tilde(p: string, home = homedir()): string {
  if (!home) return p;
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

function parseObject(path: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${tilde(path)}: invalid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${tilde(path)}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Reads and checks the config; a missing file gives `{}` (all defaults). Unknown keys are ignored. */
export function readConfigFile(path: string = configPath()): ConfigFileSettings {
  if (!existsSync(path)) return {};
  const raw = parseObject(path, readFileSync(path, "utf8"));
  for (const [key, type] of Object.entries(TYPES)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== type || (type === "number" && !Number.isFinite(v))) {
      throw new ConfigError(`${tilde(path)}: "${key}" must be a ${type}`);
    }
  }
  return raw as ConfigFileSettings;
}

/** The file's `version` (0 when it has none), or null when there is no file. */
export function fileVersion(path: string = configPath()): number | null {
  if (!existsSync(path)) return null;
  const v = readConfigFile(path).version;
  return typeof v === "number" ? v : 0;
}

export interface UpdateResult {
  created: boolean;
  added: string[];
  oldVersion: number;
  newVersion: number;
}

/**
 * Adds the template's missing settings and raises `version` to the current one. Existing settings and values are
 * never changed or removed (a newer version is left as it is). A missing file is created from the template.
 */
export function updateConfigFile(path: string = configPath()): UpdateResult {
  if (!existsSync(path)) {
    writeAtomic(path, CONFIG_TEMPLATE);
    return { created: true, added: [], oldVersion: 0, newVersion: CURRENT_VERSION };
  }
  const text = readFileSync(path, "utf8");
  const raw = parseObject(path, text);
  const oldVersion = typeof raw.version === "number" ? raw.version : 0;
  const added = Object.keys(TEMPLATE).filter((k) => k !== "version" && !(k in raw));
  const newVersion = Math.max(oldVersion, CURRENT_VERSION);
  if (added.length === 0 && newVersion === raw.version) return { created: false, added, oldVersion, newVersion };

  // `version` first (where the template has it), then the existing keys in their order, then the new ones.
  const out: Record<string, unknown> = { version: newVersion };
  for (const [k, v] of Object.entries(raw)) if (k !== "version") out[k] = v;
  for (const k of added) out[k] = TEMPLATE[k];
  writeAtomic(path, JSON.stringify(out, null, 2) + "\n");
  return { created: false, added, oldVersion, newVersion };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}
