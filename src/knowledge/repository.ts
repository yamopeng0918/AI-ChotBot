import type { IngestionJob, IngestionOperation, KnowledgeDocument } from "./types";

type DocumentRow = {
  id: string; source_type: KnowledgeDocument["sourceType"]; display_name: string;
  source_url: string | null; r2_key: string | null; active_version: number | null;
  content_hash: string | null; page_count: number | null; error_code: string | null;
  status: KnowledgeDocument["status"]; created_at: string; updated_at: string;
};

export type CreatePendingDocumentInput = {
  id: string;
  sourceType: KnowledgeDocument["sourceType"];
  displayName: string;
  sourceUrl: string | null;
  r2Key: string | null;
  contentHash?: string | null;
  createdAt: string;
};

export type CreateJobInput = {
  id: string;
  documentId: string;
  operation: IngestionOperation;
  createdAt: string;
};

const documentColumns = `id, source_type, display_name, source_url, r2_key, active_version,
  content_hash, page_count, error_code, status, created_at, updated_at`;

export class KnowledgeRepository {
  constructor(private readonly db: D1Database) {}

  async listDocuments(): Promise<KnowledgeDocument[]> {
    const result = await this.db.prepare(
      `SELECT ${documentColumns} FROM knowledge_documents ORDER BY created_at DESC, id ASC`,
    ).all<DocumentRow>();
    return result.results.map(mapDocument);
  }

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    const row = await this.db.prepare(
      `SELECT ${documentColumns} FROM knowledge_documents WHERE id = ?`,
    ).bind(id).first<DocumentRow>();
    return row ? mapDocument(row) : null;
  }

  async createPendingDocument(input: CreatePendingDocumentInput): Promise<KnowledgeDocument> {
    await this.db.prepare(`INSERT INTO knowledge_documents
      (id, source_type, display_name, source_url, r2_key, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(
      input.id, input.sourceType, input.displayName, input.sourceUrl, input.r2Key,
      input.contentHash ?? null, input.createdAt, input.createdAt,
    ).run();
    return (await this.getDocument(input.id))!;
  }

  async createJob(input: CreateJobInput): Promise<IngestionJob> {
    await this.db.prepare(`INSERT INTO ingestion_jobs
      (id, document_id, operation, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`).bind(
      input.id, input.documentId, input.operation, input.createdAt, input.createdAt,
    ).run();
    return {
      id: input.id, documentId: input.documentId, operation: input.operation, status: "pending",
      attemptCount: 0, leaseToken: null, leaseUntil: null, errorCode: null,
      createdAt: input.createdAt, updatedAt: input.createdAt,
    };
  }

  async markDeleting(id: string): Promise<boolean> {
    const result = await this.db.prepare(
      "UPDATE knowledge_documents SET status = 'deleting' WHERE id = ?",
    ).bind(id).run();
    return result.meta.changes === 1;
  }
}

function mapDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id, sourceType: row.source_type, displayName: row.display_name,
    sourceUrl: row.source_url, r2Key: row.r2_key, activeVersion: row.active_version,
    contentHash: row.content_hash, pageCount: row.page_count, errorCode: row.error_code,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
