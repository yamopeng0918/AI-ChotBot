import type { IngestionJob, IngestionOperation, KnowledgeChunk, KnowledgeDocument } from "./types";
import type { AuthorizedKnowledgeChunk } from "../retrieval/retriever";

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

export type ClaimJobResult =
  | { disposition: "acquired"; leaseToken: string; leaseUntil: string; attemptCount: number }
  | { disposition: "busy"; delaySeconds: number }
  | { disposition: "completed"; ack: true }
  | { disposition: "failed"; ack: true; failureKind: "retryable" | "permanent"; errorCode: string };

export type CleanupClaimResult = { disposition: "none" } | { disposition: "busy"; delaySeconds: number }
  | { disposition: "acquired"; cleanupToken: string; vectorIds: string[] };

type ClaimState = {
  status: IngestionJob["status"];
  attempt_count: number;
  lease_until: string | null;
  error_code: string | null;
  failure_kind: "retryable" | "permanent" | null;
};

export class StaleIngestionClaimError extends Error {
  constructor() { super("The ingestion claim is stale or expired"); this.name = "StaleIngestionClaimError"; }
}

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

  async authorizeVectorIds(ids: string[]): Promise<AuthorizedKnowledgeChunk[]> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(",");
    const result = await this.db.prepare(`SELECT c.vector_id vectorId,c.id chunkId,c.document_id documentId,c.text,
      d.display_name displayName,d.source_url sourceUrl,c.page_number pageNumber,c.section_path sectionPath,
      c.paragraph_index paragraphIndex,c.segment_index segmentIndex FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id=c.document_id AND d.status='ready' AND d.active_version=c.index_version
      WHERE c.vector_id IN (${placeholders}) ORDER BY c.vector_id,c.document_id,c.index_version,c.id`).bind(...unique).all<AuthorizedKnowledgeChunk>();
    const counts = new Map<string, number>();
    for (const row of result.results) counts.set(row.vectorId, (counts.get(row.vectorId) ?? 0) + 1);
    return result.results.filter((row) => counts.get(row.vectorId) === 1);
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

  async claimJob(jobId: string, leaseSeconds: number, now = new Date().toISOString()): Promise<ClaimJobResult> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds !== 300) throw new RangeError("leaseSeconds must be exactly 300");
    now = normalizeNow(now);
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.readClaimState(jobId);
      const settled = claimDisposition(current, now);
      if (settled) return settled;
      if (current!.attempt_count >= 4) {
        const exhausted = await this.db.prepare(`UPDATE ingestion_jobs SET status='failed',error_code='retry_exhausted',
          failure_kind='permanent',lease_token=NULL,lease_until=NULL,updated_at=?
          WHERE id=? AND attempt_count>=4 AND (status='pending' OR (status='processing' AND lease_until<=?))`)
          .bind(now, jobId, now).run();
        if (exhausted.meta.changes === 1) return { disposition: "failed", ack: true, failureKind: "permanent", errorCode: "retry_exhausted" };
        continue;
      }
      const token = this.claimToken();
      const leaseUntil = new Date(Date.parse(now) + 300_000).toISOString();
      const claimed = await this.db.prepare(`UPDATE ingestion_jobs SET status='processing',attempt_count=attempt_count+1,
        lease_token=?,lease_until=?,error_code=NULL,failure_kind=NULL,updated_at=?
        WHERE id=? AND attempt_count<4 AND (status='pending' OR (status='processing' AND lease_until<=?))`)
        .bind(token, leaseUntil, now, jobId, now).run();
      if (claimed.meta.changes !== 1) continue;
      const row = await this.db.prepare("SELECT attempt_count FROM ingestion_jobs WHERE id=? AND lease_token=?")
        .bind(jobId, token).first<{ attempt_count: number }>();
      return { disposition: "acquired", leaseToken: token, leaseUntil, attemptCount: row!.attempt_count };
    }
    return claimDisposition(await this.readClaimState(jobId), now) ?? { disposition: "busy", delaySeconds: 1 };
  }

  async claimGenerationCleanup(jobId: string, now: string): Promise<CleanupClaimResult> {
    now = normalizeNow(now);
    await this.db.prepare(`UPDATE ingestion_generation_cleanups SET status='pending' WHERE job_id=? AND status='armed'
      AND NOT EXISTS(SELECT 1 FROM ingestion_jobs j WHERE j.id=job_id AND j.status='processing'
        AND j.lease_token=owner_token AND j.lease_until>?)`).bind(jobId, now).run();
    const row = await this.db.prepare("SELECT status,cleanup_until,vector_ids FROM ingestion_generation_cleanups WHERE job_id=?")
      .bind(jobId).first<{ status: "armed" | "pending" | "processing"; cleanup_until: string | null; vector_ids: string }>();
    if (!row) return { disposition: "none" };
    if (row.status === "armed") return { disposition: "none" };
    if (row.status === "processing" && row.cleanup_until! > now) return { disposition: "busy", delaySeconds: Math.max(1, Math.ceil((Date.parse(row.cleanup_until!) - Date.parse(now)) / 1000)) };
    const cleanupToken = this.claimToken(), cleanupUntil = new Date(Date.parse(now) + 300_000).toISOString();
    const result = await this.db.prepare(`UPDATE ingestion_generation_cleanups SET status='processing',cleanup_token=?,cleanup_until=?
      WHERE job_id=? AND (status='pending' OR (status='processing' AND cleanup_until<=?))`)
      .bind(cleanupToken, cleanupUntil, jobId, now).run();
    if (result.meta.changes !== 1) return { disposition: "busy", delaySeconds: 1 };
    return { disposition: "acquired", cleanupToken, vectorIds: JSON.parse(row.vector_ids) as string[] };
  }

  async registerGeneration(jobId: string, token: string, indexVersion: number, vectorIds: string[], now: string): Promise<void> {
    now = normalizeNow(now);
    const result = await this.db.prepare(`INSERT INTO ingestion_generation_cleanups
      (job_id,document_id,index_version,vector_ids,owner_token,final_status,error_code,status)
      SELECT id,document_id,index_version,?,?,'pending','generation_incomplete','armed' FROM ingestion_jobs
      WHERE id=? AND status='processing' AND lease_token=? AND lease_until>? AND index_version=?
      ON CONFLICT(job_id) DO UPDATE SET vector_ids=excluded.vector_ids,owner_token=excluded.owner_token,status='armed',
        cleanup_token=NULL,cleanup_until=NULL WHERE ingestion_generation_cleanups.owner_token=excluded.owner_token`)
      .bind(JSON.stringify(vectorIds), token, jobId, token, now, indexVersion).run();
    this.assertLiveMutation(result.meta.changes);
  }

  async authorizeGenerationCleanup(jobId: string, token: string, indexVersion: number, vectorIds: string[], errorCode: string,
    finalStatus: "pending" | "failed", now: string): Promise<{ disposition: "authorized" | "published" | "stale" }> {
    now = normalizeNow(now);
    const state = await this.db.prepare(`SELECT j.status,j.lease_token,j.lease_until,j.document_id,j.index_version,d.active_version
      FROM ingestion_jobs j JOIN knowledge_documents d ON d.id=j.document_id WHERE j.id=?`).bind(jobId)
      .first<{ status: IngestionJob["status"]; lease_token: string | null; lease_until: string | null; document_id: string; index_version: number | null; active_version: number | null }>();
    if (state?.status === "completed" && state.index_version === indexVersion && state.active_version === indexVersion) return { disposition: "published" };
    if (!state || state.index_version !== indexVersion || state.active_version === indexVersion) return { disposition: "stale" };
    const results = await this.db.batch([
      this.db.prepare(`UPDATE ingestion_generation_cleanups SET status='pending',final_status=?,error_code=?
        WHERE job_id=? AND index_version=? AND owner_token=? AND vector_ids=? AND status='armed'
        AND NOT EXISTS(SELECT 1 FROM knowledge_documents WHERE id=document_id AND active_version=index_version)`)
        .bind(finalStatus, errorCode, jobId, indexVersion, token, JSON.stringify(vectorIds)),
      this.db.prepare(`UPDATE ingestion_jobs SET status=?,error_code=?,failure_kind=?,lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE id=? AND status='processing' AND lease_token=? AND lease_until>? AND index_version=?
        AND EXISTS(SELECT 1 FROM ingestion_generation_cleanups WHERE job_id=? AND status='pending')`)
        .bind(finalStatus, errorCode, finalStatus === "failed" ? "permanent" : "retryable", now, jobId, token, now, indexVersion, jobId),
    ]);
    return results[0]!.meta.changes === 1 ? { disposition: "authorized" } : { disposition: "stale" };
  }

  async completeGenerationCleanup(jobId: string, cleanupToken: string, now: string): Promise<void> {
    now = normalizeNow(now);
    const results = await this.db.batch([
      this.db.prepare(`DELETE FROM knowledge_chunks WHERE vector_id IN
        (SELECT value FROM json_each((SELECT vector_ids FROM ingestion_generation_cleanups WHERE job_id=?)))
        AND EXISTS(SELECT 1 FROM ingestion_generation_cleanups WHERE job_id=? AND status='processing' AND cleanup_token=? AND cleanup_until>?)`)
        .bind(jobId, jobId, cleanupToken, now),
      this.db.prepare(`DELETE FROM ingestion_generation_cleanups WHERE job_id=? AND status='processing' AND cleanup_token=? AND cleanup_until>?`)
        .bind(jobId, cleanupToken, now),
    ]);
    this.assertLiveMutation(results[1]!.meta.changes);
  }

  async releaseGenerationCleanup(jobId: string, cleanupToken: string, now: string): Promise<void> {
    now = normalizeNow(now);
    const result = await this.db.prepare(`UPDATE ingestion_generation_cleanups SET status='pending',cleanup_token=NULL,cleanup_until=NULL
      WHERE job_id=? AND status='processing' AND cleanup_token=? AND cleanup_until>?`).bind(jobId, cleanupToken, now).run();
    this.assertLiveMutation(result.meta.changes);
  }

  async renewJob(jobId: string, token: string, now: string): Promise<string> {
    now = normalizeNow(now);
    const leaseUntil = new Date(Date.parse(now) + 300_000).toISOString();
    const result = await this.db.prepare(`UPDATE ingestion_jobs SET lease_until=?,updated_at=?
      WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`)
      .bind(leaseUntil, now, jobId, token, now).run();
    this.assertLiveMutation(result.meta.changes);
    return leaseUntil;
  }

  async failJob(jobId: string, errorCode: string, failureKind: "retryable" | "permanent", token: string, now: string): Promise<void> {
    now = normalizeNow(now);
    const result = await this.db.prepare(`UPDATE ingestion_jobs SET status='failed',error_code=?,failure_kind=?,
      lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`)
      .bind(errorCode, failureKind, now, jobId, token, now).run();
    this.assertLiveMutation(result.meta.changes);
  }

  async releaseJob(jobId: string, errorCode: string, token: string, now: string): Promise<void> {
    now = normalizeNow(now);
    const result = await this.db.prepare(`UPDATE ingestion_jobs SET status='pending',error_code=?,failure_kind='retryable',
      lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`)
      .bind(errorCode, now, jobId, token, now).run();
    this.assertLiveMutation(result.meta.changes);
  }

  async beginVersion(jobId: string, token: string, now: string): Promise<number> {
    now = normalizeNow(now);
    const results = await this.db.batch([
      this.db.prepare(`UPDATE ingestion_jobs SET index_version=COALESCE(index_version,
        (SELECT next_version FROM knowledge_documents WHERE id=ingestion_jobs.document_id)),updated_at=?
        WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`).bind(now, jobId, token, now),
      this.db.prepare(`UPDATE knowledge_documents SET next_version=next_version+1
        WHERE id=(SELECT document_id FROM ingestion_jobs WHERE id=?)
        AND next_version=(SELECT index_version FROM ingestion_jobs WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?)`)
        .bind(jobId, jobId, token, now),
    ]);
    this.assertLiveMutation(results[0]!.meta.changes);
    const row = await this.db.prepare("SELECT index_version FROM ingestion_jobs WHERE id=? AND lease_token=?")
      .bind(jobId, token).first<{ index_version: number }>();
    return row!.index_version;
  }

  async stageChunks(jobId: string, token: string, chunks: KnowledgeChunk[], now: string): Promise<void> {
    now = normalizeNow(now); await this.assertLiveJob(jobId, token, now);
    const job = await this.db.prepare("SELECT document_id,index_version FROM ingestion_jobs WHERE id=? AND lease_token=?")
      .bind(jobId, token).first<{ document_id: string; index_version: number | null }>();
    if (!job?.index_version || chunks.some((chunk) => chunk.documentId !== job.document_id || chunk.indexVersion !== job.index_version)) throw new StaleIngestionClaimError();
    const statements = [
      this.db.prepare(`DELETE FROM knowledge_chunks WHERE document_id=? AND index_version=?
        AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?)`)
        .bind(job.document_id, job.index_version, jobId, token, now),
      ...chunks.map((chunk) => this.db.prepare(`INSERT INTO knowledge_chunks
        (id,document_id,index_version,text,page_number,section_path,paragraph_index,segment_index,vector_id,content_hash,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ingestion_jobs
          WHERE id=? AND document_id=? AND index_version=? AND status='processing' AND lease_token=? AND lease_until>?)`)
        .bind(chunk.id, chunk.documentId, chunk.indexVersion, chunk.text, chunk.pageNumber, chunk.sectionPath,
          chunk.paragraphIndex, chunk.segmentIndex, chunk.vectorId, chunk.contentHash, chunk.createdAt,
          jobId, chunk.documentId, chunk.indexVersion, token, now)),
    ];
    const results = await this.db.batch(statements);
    if (results.slice(1).some((result) => result.meta.changes !== 1)) throw new StaleIngestionClaimError();
  }

  async countStagedChunks(jobId: string, token: string, now: string): Promise<number> {
    now = normalizeNow(now); await this.assertLiveJob(jobId, token, now);
    const row = await this.db.prepare(`SELECT COUNT(*) count FROM knowledge_chunks WHERE document_id=(SELECT document_id FROM ingestion_jobs WHERE id=?)
      AND index_version=(SELECT index_version FROM ingestion_jobs WHERE id=?)`).bind(jobId, jobId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async cleanupStaging(jobId: string, token: string, now: string): Promise<void> {
    now = normalizeNow(now); await this.assertLiveJob(jobId, token, now);
    await this.db.prepare(`DELETE FROM knowledge_chunks WHERE document_id=(SELECT document_id FROM ingestion_jobs WHERE id=?)
      AND index_version=(SELECT index_version FROM ingestion_jobs WHERE id=?)
      AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?)`)
      .bind(jobId, jobId, jobId, token, now).run();
  }

  async listVectorIds(documentId: string, indexVersion?: number): Promise<string[]> {
    const statement = indexVersion === undefined
      ? this.db.prepare("SELECT vector_id FROM knowledge_chunks WHERE document_id=? ORDER BY vector_id").bind(documentId)
      : this.db.prepare("SELECT vector_id FROM knowledge_chunks WHERE document_id=? AND index_version=? ORDER BY vector_id").bind(documentId, indexVersion);
    const result = await statement.all<{ vector_id: string }>();
    return result.results.map((row) => row.vector_id);
  }

  async publishVersion(jobId: string, token: string, expectedCountOrNow: number | string, at?: string): Promise<void> {
    const expectedCount = typeof expectedCountOrNow === "number" ? expectedCountOrNow : await this.countStagedChunks(jobId, token, expectedCountOrNow);
    let now = typeof expectedCountOrNow === "string" ? expectedCountOrNow : at!;
    now = normalizeNow(now);
    if (typeof expectedCountOrNow === "number") {
      const published = await this.db.prepare(`SELECT 1 ok FROM ingestion_jobs j JOIN knowledge_documents d ON d.id=j.document_id
        WHERE j.id=? AND j.status='completed' AND j.index_version=d.active_version AND j.index_version IS NOT NULL`).bind(jobId).first();
      if (published) return;
    }
    const publication = this.db.prepare(`UPDATE knowledge_documents SET active_version=(SELECT index_version FROM ingestion_jobs WHERE id=?),
      status='ready',error_code=NULL,updated_at=? WHERE id=(SELECT document_id FROM ingestion_jobs WHERE id=?)
      AND EXISTS (SELECT 1 FROM ingestion_jobs WHERE id=? AND status='processing' AND lease_token=? AND lease_until>? AND index_version IS NOT NULL)
      AND ?=(SELECT COUNT(*) FROM knowledge_chunks WHERE document_id=knowledge_documents.id
        AND index_version=(SELECT index_version FROM ingestion_jobs WHERE id=?))
      AND (? OR EXISTS(SELECT 1 FROM ingestion_generation_cleanups WHERE job_id=? AND owner_token=? AND status='armed'))
      AND (active_version IS NULL OR active_version<=(SELECT index_version FROM ingestion_jobs WHERE id=?))`)
      .bind(jobId, now, jobId, jobId, token, now, expectedCount, jobId, typeof expectedCountOrNow === "string" ? 1 : 0, jobId, token, jobId);
    if (typeof expectedCountOrNow === "string") {
      const result = await publication.run(); this.assertLiveMutation(result.meta.changes); return;
    }
    const completion = this.db.prepare(`UPDATE ingestion_jobs SET status='completed',lease_token=NULL,lease_until=NULL,
      error_code=NULL,failure_kind=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?
      AND ?=(SELECT COUNT(*) FROM knowledge_chunks WHERE document_id=ingestion_jobs.document_id AND index_version=ingestion_jobs.index_version)
      AND EXISTS(SELECT 1 FROM knowledge_documents WHERE id=ingestion_jobs.document_id AND active_version=ingestion_jobs.index_version)`)
      .bind(now, jobId, token, now, expectedCount);
    const retireGeneration = this.db.prepare(`DELETE FROM ingestion_generation_cleanups
      WHERE job_id=? AND owner_token=? AND status='armed'
      AND EXISTS(SELECT 1 FROM ingestion_jobs j JOIN knowledge_documents d ON d.id=j.document_id
        WHERE j.id=? AND j.status='completed' AND j.index_version=d.active_version)`).bind(jobId, token, jobId);
    const results = await this.db.batch([publication, completion, retireGeneration]);
    this.assertLiveMutation(results[0]!.meta.changes); this.assertLiveMutation(results[1]!.meta.changes); this.assertLiveMutation(results[2]!.meta.changes);
  }

  async completeJob(jobId: string, token: string, now: string): Promise<void> {
    now = normalizeNow(now);
    const result = await this.db.prepare(`UPDATE ingestion_jobs SET status='completed',lease_token=NULL,lease_until=NULL,
      error_code=NULL,failure_kind=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`)
      .bind(now, jobId, token, now).run();
    this.assertLiveMutation(result.meta.changes);
  }

  private assertLiveMutation(changes: number): void {
    if (changes !== 1) throw new StaleIngestionClaimError();
  }

  private async assertLiveJob(jobId: string, token: string, now: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE ingestion_jobs SET updated_at=updated_at
      WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`).bind(jobId, token, now).run();
    this.assertLiveMutation(result.meta.changes);
  }

  private readClaimState(jobId: string): Promise<ClaimState | null> {
    return this.db.prepare(`SELECT status,attempt_count,lease_until,error_code,failure_kind
      FROM ingestion_jobs WHERE id=?`).bind(jobId).first<ClaimState>();
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

  async abandonUploadClaim(documentId: string, token: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM knowledge_documents WHERE id=? AND status='processing' AND upload_claim_token=?
      AND NOT EXISTS (SELECT 1 FROM ingestion_jobs WHERE document_id=knowledge_documents.id)`).bind(documentId, token).run();
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

function normalizeNow(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError("now must be a valid date");
  return new Date(milliseconds).toISOString();
}

function claimDisposition(current: ClaimState | null, now: string): ClaimJobResult | null {
  if (!current) return { disposition: "failed", ack: true, failureKind: "permanent", errorCode: "not_found" };
  if (current.status === "completed") return { disposition: "completed", ack: true };
  if (current.status === "failed") return {
    disposition: "failed", ack: true, failureKind: current.failure_kind ?? "permanent", errorCode: current.error_code ?? "unknown",
  };
  if (current.status === "processing" && current.lease_until! > now) return {
    disposition: "busy",
    delaySeconds: Math.max(1, Math.ceil((Date.parse(current.lease_until!) - Date.parse(now)) / 1000)),
  };
  return null;
}
