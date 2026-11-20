import type { Database } from "bun:sqlite";

export const SETTING_KEYS = ["libraryRoot", "contactEmail", "envLibraryRootSeen"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function get(db: Database, key: SettingKey): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | null;
  return row?.value ?? null;
}

export function set(db: Database, key: SettingKey, value: string | null): void {
  if (value === null) db.query("DELETE FROM settings WHERE key = ?").run(key);
  else db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
