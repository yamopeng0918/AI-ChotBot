CREATE TABLE IF NOT EXISTS group_settings (
  group_id TEXT PRIMARY KEY,
  default_weather_city TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_cache (
  cache_key TEXT PRIMARY KEY,
  answer_text TEXT NOT NULL,
  model TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weather_cache_expires_at ON weather_cache(expires_at);
