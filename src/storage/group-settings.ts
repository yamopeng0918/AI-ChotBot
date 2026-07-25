type GroupSettingsRow = {
  group_id: string;
  default_weather_city: string | null;
  updated_at: string;
};

export class GroupSettingsRepository {
  constructor(private readonly db: D1Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async getWeatherCity(groupId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT default_weather_city FROM group_settings WHERE group_id = ?1")
      .bind(groupId)
      .first<GroupSettingsRow>();
    return row?.default_weather_city ?? null;
  }

  async setWeatherCity(groupId: string, city: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO group_settings (group_id, default_weather_city, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(group_id) DO UPDATE SET default_weather_city = excluded.default_weather_city, updated_at = excluded.updated_at",
      )
      .bind(groupId, city, this.now())
      .run();
  }

  async clearWeatherCity(groupId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM group_settings WHERE group_id = ?1").bind(groupId).run();
    return (result.meta.changes ?? 0) > 0;
  }
}
