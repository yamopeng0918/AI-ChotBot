ALTER TABLE knowledge_chunks ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0 CHECK(segment_index >= 0);

CREATE TABLE ingestion_generation_cleanups (
  job_id TEXT PRIMARY KEY REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  index_version INTEGER NOT NULL CHECK(index_version >= 1),
  vector_ids TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  final_status TEXT NOT NULL CHECK(final_status IN ('pending','failed')),
  error_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('armed','pending','processing')),
  cleanup_token TEXT,
  cleanup_until TEXT,
  CHECK ((status='processing' AND cleanup_token IS NOT NULL AND cleanup_until IS NOT NULL) OR
         (status IN ('armed','pending') AND cleanup_token IS NULL AND cleanup_until IS NULL))
);
