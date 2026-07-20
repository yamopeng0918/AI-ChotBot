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

  async claimUpload(document: CreatePendingDocumentInput, jobId: string, now: string): Promise<{ disposition: "winner" | "busy" | "resume_queue" | "duplicate" }> {
    const staleBefore = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
    const result = await this.db.prepare(`INSERT INTO knowledge_documents
      (id, source_type, display_name, source_url, r2_key, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, source_url=excluded.source_url,
        r2_key=excluded.r2_key, content_hash=excluded.content_hash, status='processing', error_code=NULL,
        updated_at=excluded.updated_at
      WHERE knowledge_documents.status='failed' OR
        (knowledge_documents.status='processing' AND knowledge_documents.updated_at <= ?)`).bind(
      document.id, document.sourceType, document.displayName, document.sourceUrl, document.r2Key,
      document.contentHash ?? null, document.createdAt, now, staleBefore,
    ).run();
    if (result.meta.changes === 1) return { disposition: "winner" };
    const row = await this.db.prepare(`SELECT d.status document_status, j.id job_id, j.status job_status
      FROM knowledge_documents d LEFT JOIN ingestion_jobs j ON j.document_id=d.id AND j.id=? WHERE d.id=?`)
      .bind(jobId, document.id).first<{ document_status: KnowledgeDocument["status"]; job_id: string | null; job_status: IngestionJob["status"] | null }>();
    if (!row) throw new Error("upload claim disappeared");
    if (row.document_status === "processing") return { disposition: "busy" };
    if (row.document_status === "pending" && !row.job_id) throw new Error("pending upload missing stable job");
    if (row.document_status === "pending" && row.job_status === "pending") return { disposition: "resume_queue" };
    return { disposition: "duplicate" };
  }

  async completeUpload(documentId: string, job: CreateJobInput, updatedAt: string): Promise<void> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO ingestion_jobs
        (id, document_id, operation, status, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(id) DO UPDATE SET status='pending', error_code=NULL, lease_token=NULL, lease_until=NULL,
          updated_at=excluded.updated_at WHERE ingestion_jobs.document_id=excluded.document_id AND ingestion_jobs.status='failed'`)
        .bind(job.id, job.documentId, job.operation, job.createdAt, job.createdAt),
      this.db.prepare(`UPDATE knowledge_documents SET status = 'pending', updated_at = ?
        WHERE id = ? AND status = 'processing'`).bind(updatedAt, documentId),
    ]);
    if (results[1]!.meta.changes !== 1) throw new Error("upload claim lost");
  }

  async failUpload(documentId: string, jobId: string, errorCode: string, updatedAt: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE ingestion_jobs SET status = 'failed', error_code = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND document_id = ?`)
        .bind(errorCode, updatedAt, jobId, documentId),
      this.db.prepare(`UPDATE knowledge_documents SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?`)
        .bind(errorCode, updatedAt, documentId),
    ]);
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
