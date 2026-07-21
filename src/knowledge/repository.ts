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
  constructor(private readonly db: D1Database, private readonly claimToken = () => crypto.randomUUID()) {}

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

  async claimUpload(document: CreatePendingDocumentInput, jobId: string, now: string, extension: string): Promise<{ disposition: "winner"; token: string; r2Key: string; previousR2Key: string | null } | { disposition: "busy" | "resume_queue" | "duplicate" }> {
    const staleBefore = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
    const until = new Date(new Date(now).getTime() + 5 * 60_000).toISOString();
    const token = this.claimToken();
    const tokenHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].slice(0, 8).map((b) => b.toString(16).padStart(2,"0")).join("");
    const r2Key = `${document.id}-${tokenHash}${extension}`;
    const previous = await this.db.prepare("SELECT r2_key FROM knowledge_documents WHERE id=?").bind(document.id).first<{r2_key:string|null}>();
    const result = await this.db.prepare(`INSERT INTO knowledge_documents
      (id, source_type, display_name, source_url, r2_key, content_hash, status, created_at, updated_at, upload_claim_token, upload_claim_until)
      VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, source_url=excluded.source_url,
        r2_key=excluded.r2_key, content_hash=excluded.content_hash, status='processing', error_code=NULL,
        upload_claim_token=excluded.upload_claim_token, upload_claim_until=excluded.upload_claim_until, updated_at=excluded.updated_at
      WHERE knowledge_documents.status='failed' OR
        (knowledge_documents.status='processing' AND knowledge_documents.updated_at <= ?)`).bind(
      document.id, document.sourceType, document.displayName, document.sourceUrl, r2Key,
      document.contentHash ?? null, document.createdAt, now, token, until, staleBefore,
    ).run();
    if (result.meta.changes === 1) return { disposition: "winner", token, r2Key, previousR2Key: previous?.r2_key ?? null };
    const row = await this.db.prepare(`SELECT d.status document_status, j.id job_id, j.status job_status
      FROM knowledge_documents d LEFT JOIN ingestion_jobs j ON j.document_id=d.id AND j.id=? WHERE d.id=?`)
      .bind(jobId, document.id).first<{ document_status: KnowledgeDocument["status"]; job_id: string | null; job_status: IngestionJob["status"] | null }>();
    if (!row) throw new Error("upload claim disappeared");
    if (row.document_status === "processing") return { disposition: "busy" };
    if (row.document_status === "pending" && !row.job_id) throw new Error("pending upload missing stable job");
    if (row.document_status === "pending" && row.job_status === "pending") return { disposition: "resume_queue" };
    return { disposition: "duplicate" };
  }

  async completeUpload(documentId: string, job: CreateJobInput, token: string, updatedAt: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO ingestion_jobs
        (id, document_id, operation, status, created_at, updated_at)
        SELECT ?, ?, ?, 'pending', ?, ? WHERE EXISTS
          (SELECT 1 FROM knowledge_documents WHERE id=? AND status='processing' AND upload_claim_token=?)
        ON CONFLICT(id) DO UPDATE SET status='pending', error_code=NULL, lease_token=NULL, lease_until=NULL,
          updated_at=excluded.updated_at WHERE ingestion_jobs.document_id=excluded.document_id AND ingestion_jobs.status='failed'`)
        .bind(job.id, job.documentId, job.operation, job.createdAt, job.createdAt, documentId, token),
      this.db.prepare(`UPDATE knowledge_documents SET status = 'pending', updated_at = ?
        WHERE id = ? AND status = 'processing' AND upload_claim_token=?`).bind(updatedAt, documentId, token),
    ]);
    return results[0]!.meta.changes === 1 && results[1]!.meta.changes === 1;
  }

  async updateUploadClaim(documentId: string, token: string, input: { displayName: string; sourceUrl: string; contentHash: string; updatedAt: string }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE knowledge_documents SET display_name=?, source_url=?, content_hash=?, updated_at=?
      WHERE id=? AND status='processing' AND upload_claim_token=?`).bind(input.displayName, input.sourceUrl, input.contentHash, input.updatedAt, documentId, token).run();
    return result.meta.changes === 1;
  }

  async failUpload(documentId: string, jobId: string, errorCode: string, updatedAt: string, token: string): Promise<boolean> {
    await this.db.batch([
      this.db.prepare(`UPDATE ingestion_jobs SET status = 'failed', error_code = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND document_id = ? AND EXISTS
          (SELECT 1 FROM knowledge_documents WHERE id=? AND upload_claim_token=?)`)
        .bind(errorCode, updatedAt, jobId, documentId, documentId, token),
      this.db.prepare(`UPDATE knowledge_documents SET status = 'failed', error_code = ?, upload_claim_until=NULL, updated_at = ?
        WHERE id = ? AND upload_claim_token=? AND status IN ('processing','pending')`)
        .bind(errorCode, updatedAt, documentId, token),
    ]);
    return true;
  }

  async clearUploadClaim(documentId: string, token: string, updatedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE knowledge_documents SET upload_claim_token=NULL, upload_claim_until=NULL, updated_at=?
      WHERE id=? AND status='pending' AND upload_claim_token=?`).bind(updatedAt, documentId, token).run();
    return result.meta.changes === 1;
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
