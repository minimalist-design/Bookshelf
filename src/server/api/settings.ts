import type { AppContext } from "../app.ts";
import type { SettingsDto, SettingsUpdate } from "../../shared/types.ts";
import { existsSync } from "node:fs";
import { createLibraryRoot, validateLibraryRoot, ValidationError } from "../library/paths.ts";
import * as settingsRepo from "../db/repo/settings.ts";

export function getSettings(app: AppContext): SettingsDto {
  const t = app.tools;
  return {
    libraryRoot: app.libraryRoot(),
    libraryRootFromConfig: app.config.configLibraryRoot !== null,
    contactEmail: settingsRepo.get(app.db, "contactEmail"),
    dataDir: app.config.dataDir,
    tools: {
      sevenZip: !!t.sevenZip,
      unrar: !!t.unrar,
      djvused: !!t.djvused,
      ddjvu: !!t.ddjvu,
      pdftoppm: !!t.pdftoppm,
    },
    isbndb: {
      configured: app.config.isbndb.apiKey !== null,
      dailyLimit: app.config.isbndb.dailyLimit,
      perSecond: app.config.isbndb.perSecond,
    },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function updateSettings(app: AppContext, update: SettingsUpdate): SettingsDto {
  if (update.libraryRoot !== undefined) {
    if (app.config.configLibraryRoot) throw new ValidationError("Library root is set in the config file (library_root)");
    // null unlinks the library only: files and directories stay as they are.
    const root =
      update.libraryRoot === null
        ? null
        : update.createLibraryRoot
          ? createLibraryRoot(update.libraryRoot, app.config.dataDir)
          : validateLibraryRoot(update.libraryRoot, app.config.dataDir);
    const changed = root !== settingsRepo.get(app.db, "libraryRoot");
    settingsRepo.set(app.db, "libraryRoot", root);
    // Re-index in the background; clients follow progress via library.status events.
    // With no root, open() only clears the in-memory index.
    if (changed) app.library.open(root).catch((err) => console.error("Library scan failed:", err));
  }
  if (update.contactEmail !== undefined) {
    const email = update.contactEmail?.trim() || null;
    if (email && !EMAIL.test(email)) throw new ValidationError("Invalid email address");
    settingsRepo.set(app.db, "contactEmail", email);
  }
  return getSettings(app);
}

/**
 * Create a missing `library_root` from the config file, but only the first time this path is configured: later on, a missing
 * root more likely means an unmounted drive, which must stay "unavailable" rather than be replaced by an empty folder.
 */
export function prepareConfigLibraryRoot(app: AppContext): void {
  const root = app.config.configLibraryRoot;
  // The setting key predates the config file (the root used to come from an environment variable).
  if (!root || settingsRepo.get(app.db, "envLibraryRootSeen") === root) return;
  if (!existsSync(root)) {
    try {
      createLibraryRoot(root, app.config.dataDir);
      console.log(`Created library directory: ${root}`);
    } catch (err) {
      console.error(`Cannot create library directory: ${err instanceof Error ? err.message : err}`);
      return; // retry on next start
    }
  }
  settingsRepo.set(app.db, "envLibraryRootSeen", root);
}
