import type { AppContext } from "../app.ts";
import type { SettingsDto, SettingsUpdate } from "../../shared/types.ts";
import { validateLibraryRoot, ValidationError } from "../library/paths.ts";

export function getSettings(app: AppContext): SettingsDto {
  const t = app.tools;
  return {
    libraryRoot: app.libraryRoot(),
    libraryRootFromEnv: app.config.envLibraryRoot !== null,
    contactEmail: app.settings.get("contactEmail"),
    dataDir: app.config.dataDir,
    tools: {
      sevenZip: !!t.sevenZip,
      unrar: !!t.unrar,
      djvused: !!t.djvused,
      ddjvu: !!t.ddjvu,
      pdftoppm: !!t.pdftoppm,
    },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function updateSettings(app: AppContext, update: SettingsUpdate): SettingsDto {
  if (update.libraryRoot !== undefined) {
    if (app.config.envLibraryRoot) throw new ValidationError("Library root is set by BOOKSHELF_LIBRARY_ROOT");
    const root = validateLibraryRoot(update.libraryRoot, app.config.dataDir);
    const changed = root !== app.settings.get("libraryRoot");
    app.settings.set("libraryRoot", root);
    // Re-index in the background; clients follow progress via library.status events.
    if (changed) app.library.open(root).catch((err) => console.error("Library scan failed:", err));
  }
  if (update.contactEmail !== undefined) {
    const email = update.contactEmail?.trim() || null;
    if (email && !EMAIL.test(email)) throw new ValidationError("Invalid email address");
    app.settings.set("contactEmail", email);
  }
  return getSettings(app);
}
