ALTER TABLE knowledge_documents ADD COLUMN next_version INTEGER NOT NULL DEFAULT 1 CHECK(next_version >= 1);
UPDATE knowledge_documents
SET next_version = active_version + 1
WHERE active_version IS NOT NULL AND next_version <= active_version;

ALTER TABLE ingestion_jobs ADD COLUMN index_version INTEGER CHECK(index_version IS NULL OR index_version >= 1);
ALTER TABLE ingestion_jobs ADD COLUMN failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('retryable','permanent'));
