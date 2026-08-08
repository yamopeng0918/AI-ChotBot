CREATE TABLE knowledge_drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
  markdown TEXT NOT NULL CHECK (length(markdown) BETWEEN 1 AND 65536),
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array'),
  dedupe_key TEXT NOT NULL UNIQUE,
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK ((status = 'approved' AND document_id IS NOT NULL AND reviewed_at IS NOT NULL) OR status != 'approved'),
  CHECK ((status = 'rejected' AND reviewed_at IS NOT NULL) OR status != 'rejected')
);

CREATE INDEX idx_knowledge_drafts_status_updated ON knowledge_drafts(status, updated_at DESC);
CREATE INDEX idx_knowledge_drafts_expiry ON knowledge_drafts(status, expires_at);
