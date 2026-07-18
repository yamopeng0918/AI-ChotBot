CREATE TABLE questions (
  webhook_event_id TEXT PRIMARY KEY,
  user_key TEXT,
  question TEXT,
  answer TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing','answered','provider_unavailable','reply_failed')),
  prepared_status TEXT CHECK (prepared_status IN ('answered','provider_unavailable')),
  lease_until TEXT,
  lease_token TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX questions_created_at_idx ON questions(created_at);
CREATE INDEX questions_expires_at_idx ON questions(expires_at);
CREATE INDEX questions_lease_until_idx ON questions(lease_until);
CREATE INDEX questions_user_key_idx ON questions(user_key);
