type WeatherCacheRow = {
  cache_key: string;
  answer_text: string;
  model: string;
  expires_at: string;
  created_at: string;
};

export type WeatherCacheRecord = {
  cacheKey: string;
  answerText: string;
  model: string;
  expiresAt: string;
  createdAt: string;
};

export class WeatherCacheRepository {
  constructor(private readonly db: D1Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async get(cacheKey: string, nowIso: string = this.now()): Promise<WeatherCacheRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT cache_key, answer_text, model, expires_at, created_at FROM weather_cache WHERE cache_key = ?1 AND expires_at > ?2",
      )
      .bind(cacheKey, nowIso)
      .first<WeatherCacheRow>();

    if (!row) return null;
    return {
      cacheKey: row.cache_key,
      answerText: row.answer_text,
      model: row.model,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async set(record: WeatherCacheRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO weather_cache (cache_key, answer_text, model, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO UPDATE SET answer_text = excluded.answer_text, model = excluded.model, expires_at = excluded.expires_at, created_at = excluded.created_at",
      )
      .bind(record.cacheKey, record.answerText, record.model, record.expiresAt, record.createdAt)
      .run();
  }
}
