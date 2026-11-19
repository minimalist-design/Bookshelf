import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { expandTilde, type ConfigFileSettings } from "./configFile.ts";

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  coversDir: string;
  port: number;
  hostname: string;
  /** Library root set in the config file (`library_root`); overrides and locks the UI setting when present. */
  configLibraryRoot: string | null;
  isProduction: boolean;
  /** Largest accepted upload (`max_upload_mb`, default 16 GiB). */
  maxUploadBytes: number;
}

/**
 * Turns the config file's settings into the app's config, filling in defaults. `env` only supplies
 * `XDG_DATA_HOME` (the default data directory) and `NODE_ENV`.
 */
export function loadConfig(file: ConfigFileSettings = {}, env: Record<string, string | undefined> = process.env): AppConfig {
  const xdgData = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dataDir = resolve(file.data_dir ? expandTilde(file.data_dir) : join(xdgData, "bookshelf"));
  return {
    dataDir,
    dbPath: join(dataDir, "bookshelf.db"),
    coversDir: join(dataDir, "covers"),
    port: file.port ?? 3000,
    hostname: file.host || "0.0.0.0",
    configLibraryRoot: file.library_root ? resolve(expandTilde(file.library_root)) : null,
    // `process.env.NODE_ENV` is inlined as "production" by `scripts/build.ts`, so the compiled binary is always production.
    isProduction: env.NODE_ENV === "production" || process.env.NODE_ENV === "production",
    maxUploadBytes: (file.max_upload_mb ?? 16 * 1024) * 1024 * 1024,
  };
}

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
