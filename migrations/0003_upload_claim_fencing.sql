ALTER TABLE knowledge_documents ADD COLUMN upload_claim_token TEXT;
ALTER TABLE knowledge_documents ADD COLUMN upload_claim_until TEXT;
CREATE INDEX knowledge_documents_upload_claim_until_idx ON knowledge_documents(upload_claim_until);
