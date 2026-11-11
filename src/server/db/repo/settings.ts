import type { Database } from "bun:sqlite";

export const SETTING_KEYS = ["libraryRoot", "contactEmail"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get(key: SettingKey): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | null;
    return row?.value ?? null;
  }

  set(key: SettingKey, value: string | null): void {
    if (value === null) {
      this.db.query("DELETE FROM settings WHERE key = ?").run(key);
    } else {
      this.db
        .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    }
  }
}
