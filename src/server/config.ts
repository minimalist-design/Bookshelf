import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  coversDir: string;
  port: number;
  hostname: string;
  /** Library root forced by environment; overrides the DB setting when present. */
  envLibraryRoot: string | null;
  isProduction: boolean;
  /** Largest accepted upload (BOOKSHELF_MAX_UPLOAD_MB, default 16 GiB). */
  maxUploadBytes: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const xdgData = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dataDir = resolve(env.BOOKSHELF_DATA_DIR || join(xdgData, "bookshelf"));
  return {
    dataDir,
    dbPath: join(dataDir, "bookshelf.db"),
    coversDir: join(dataDir, "covers"),
    port: Number(env.BOOKSHELF_PORT || env.PORT || 3000),
    hostname: env.BOOKSHELF_HOST || "0.0.0.0",
    envLibraryRoot: env.BOOKSHELF_LIBRARY_ROOT ? resolve(env.BOOKSHELF_LIBRARY_ROOT) : null,
    isProduction: env.NODE_ENV === "production",
    maxUploadBytes: Number(env.BOOKSHELF_MAX_UPLOAD_MB || 16 * 1024) * 1024 * 1024,
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
