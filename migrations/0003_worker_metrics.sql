CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_event_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  duration_ms INTEGER NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metrics_created_at ON metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_intent_created_at ON metrics(intent, created_at DESC);
