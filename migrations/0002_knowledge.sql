CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('file','url')),
  display_name TEXT NOT NULL,
  source_url TEXT,
  r2_key TEXT,
  active_version INTEGER CHECK (active_version IS NULL OR active_version >= 1),
  content_hash TEXT,
  page_count INTEGER CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 100),
  error_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','ready','failed','deleting')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (source_type = 'file' AND r2_key IS NOT NULL AND source_url IS NULL) OR
    (source_type = 'url' AND source_url IS NOT NULL AND r2_key IS NULL)
  )
);

CREATE INDEX knowledge_documents_status_idx ON knowledge_documents(status);
CREATE INDEX knowledge_documents_active_version_idx ON knowledge_documents(active_version);
CREATE INDEX knowledge_documents_content_hash_idx ON knowledge_documents(content_hash);

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  index_version INTEGER NOT NULL CHECK (index_version >= 1),
  text TEXT NOT NULL,
  page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
  section_path TEXT,
  paragraph_index INTEGER CHECK (paragraph_index IS NULL OR paragraph_index >= 0),
  vector_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, index_version, vector_id)
);

CREATE INDEX knowledge_chunks_document_id_idx ON knowledge_chunks(document_id);

CREATE TABLE ingestion_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('ingest','reindex','delete')),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_until TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
    (status <> 'processing' AND lease_token IS NULL AND lease_until IS NULL)
  )
);

CREATE INDEX ingestion_jobs_status_lease_until_idx ON ingestion_jobs(status, lease_until);
CREATE INDEX ingestion_jobs_document_id_idx ON ingestion_jobs(document_id);
