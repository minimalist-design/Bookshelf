import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { expandTilde, type ConfigFileSettings } from "./configFile.ts";

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  coversDir: string;
  /** The configured port; null when none is assigned yet (`"port": 0`), and one is picked on first start. */
  port: number | null;
  hostname: string;
  /** Library root set in the config file (`library_root`); overrides and locks the UI setting when present. */
  configLibraryRoot: string | null;
  isProduction: boolean;
  /** Largest accepted upload (`max_upload_mb`, default 16 GiB). */
  maxUploadBytes: number;
  isbndb: IsbndbConfig;
}

/** ISBNdb: the key comes from the environment (`ISBNDB_API_KEY`), the plan's limits from the config file. */
export interface IsbndbConfig {
  /** Null: ISBNdb is not used. Never logged or sent anywhere but ISBNdb. */
  apiKey: string | null;
  dailyLimit: number;
  perSecond: number;
  bulkSize: number;
}

/** The secrets read from the environment; `.env.example` lists exactly these (a test checks it). */
export const SECRET_ENV_NAMES = ["ISBNDB_API_KEY"] as const;

/** Basic plan limits, used when the config file doesn't set them. */
export const ISBNDB_DEFAULTS = { dailyLimit: 5000, perSecond: 1, bulkSize: 100 } as const;

/**
 * Turns the config file's settings into the app's config, filling in defaults. `env` only supplies
 * `XDG_DATA_HOME` (the default data directory), `NODE_ENV` and the `ISBNDB_API_KEY` secret.
 */
export function loadConfig(file: ConfigFileSettings = {}, env: Record<string, string | undefined> = process.env): AppConfig {
  const xdgData = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dataDir = resolve(file.data_dir ? expandTilde(file.data_dir) : join(xdgData, "bookshelf"));
  return {
    dataDir,
    dbPath: join(dataDir, "bookshelf.db"),
    coversDir: join(dataDir, "covers"),
    port: file.port ? file.port : null,
    hostname: file.host || "0.0.0.0",
    configLibraryRoot: file.library_root ? resolve(expandTilde(file.library_root)) : null,
    // `process.env.NODE_ENV` is inlined as "production" by `scripts/build.ts`, so the compiled binary is always production.
    isProduction: env.NODE_ENV === "production" || process.env.NODE_ENV === "production",
    maxUploadBytes: (file.max_upload_mb ?? 16 * 1024) * 1024 * 1024,
    isbndb: {
      apiKey: env.ISBNDB_API_KEY?.trim() || null,
      dailyLimit: positive(file.isbndb_daily_limit) ?? ISBNDB_DEFAULTS.dailyLimit,
      perSecond: positive(file.isbndb_per_second) ?? ISBNDB_DEFAULTS.perSecond,
      bulkSize: Math.floor(positive(file.isbndb_bulk_size) ?? ISBNDB_DEFAULTS.bulkSize),
    },
  };
}

/** A usable positive number, else undefined (0 or empty means "the default"). */
const positive = (v: number | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function ensureDataDirs(config: AppConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.coversDir, { recursive: true });
}

/** Optional external CLI tools; absence only degrades metadata/cover extraction for some formats. */
export interface ExternalTools {
  sevenZip: string | null;
  unrar: string | null;
  djvused: string | null;
  ddjvu: string | null;
  pdftoppm: string | null;
}

export function detectExternalTools(): ExternalTools {
  return {
    sevenZip: Bun.which("7z") ?? Bun.which("7zz") ?? null,
    unrar: Bun.which("unrar") ?? null,
    djvused: Bun.which("djvused") ?? null,
    ddjvu: Bun.which("ddjvu") ?? null,
    pdftoppm: Bun.which("pdftoppm") ?? null,
  };
}
