import { chunkDocument, type KnowledgeChunkDraft } from "./chunker";
import { ConversionError, type ConversionKind, type DocumentConverter } from "./converter";
import { EmbeddingError, type EmbeddingService } from "./embeddings";
import { StaleIngestionClaimError, type ClaimJobResult, type IngestionJobDetails } from "./repository";
import type { IngestionJobMessage, KnowledgeChunk, KnowledgeDocument } from "./types";
import { vectorIdFor, type KnowledgeVectorStore } from "./vector-store";

type IngestionRepository = {
  claimGenerationCleanup(jobId: string, now: string): Promise<{ disposition: "none" } | { disposition: "busy"; delaySeconds: number } | { disposition: "acquired"; cleanupToken: string; vectorIds: string[] }>;
  registerGeneration(jobId: string, token: string, indexVersion: number, vectorIds: string[], now: string): Promise<void>;
  authorizeGenerationCleanup(jobId: string, token: string, indexVersion: number, vectorIds: string[], errorCode: string, finalStatus: "pending" | "failed", now: string): Promise<{ disposition: "authorized" | "published" | "stale" }>;
  completeGenerationCleanup(jobId: string, cleanupToken: string, now: string): Promise<void>;
  releaseGenerationCleanup(jobId: string, cleanupToken: string, now: string): Promise<void>;
  getJob(jobId: string): Promise<IngestionJobDetails | null>;
  claimJob(jobId: string, leaseSeconds: number, now: string): Promise<ClaimJobResult>;
  getDocument(id: string): Promise<KnowledgeDocument | null>;
  listVectorIds(documentId: string, indexVersion?: number): Promise<string[]>;
  beginVersion(jobId: string, token: string, now: string): Promise<number>;
  renewJob(jobId: string, token: string, now: string): Promise<string>;
  stageChunks(jobId: string, token: string, chunks: KnowledgeChunk[], now: string): Promise<void>;
  countStagedChunks(jobId: string, token: string, now: string): Promise<number>;
  cleanupStaging(jobId: string, token: string, now: string): Promise<void>;
  publishVersion(jobId: string, token: string, expectedCount: number, now: string): Promise<void>;
  releaseJob(jobId: string, errorCode: string, token: string, now: string): Promise<void>;
  failJob(jobId: string, errorCode: string, failureKind: "retryable" | "permanent", token: string, now: string): Promise<void>;
  completeDeletion(jobId: string, token: string, indexVersion: number | null, now: string): Promise<void>;
};
type SourceStore = { getOriginal(key: string): Promise<{ blob(): Promise<Blob> } | null>; deleteOriginal(key: string): Promise<void> };

export type IngestionDependencies = {
  repository: IngestionRepository; objectStore: SourceStore; converter: Pick<DocumentConverter, "convert">;
  chunk?: typeof chunkDocument; embeddings: Pick<EmbeddingService, "embed">;
  vectors: Pick<KnowledgeVectorStore, "upsert" | "deleteIds">; now?: () => Date;
};
export type IngestionResult = { disposition: "ack" } | { disposition: "retry"; delaySeconds: number };

export async function processIngestionJob(message: IngestionJobMessage, dependencies: IngestionDependencies): Promise<IngestionResult> {
  const now = () => (dependencies.now?.() ?? new Date()).toISOString();
  const cleanup = await dependencies.repository.claimGenerationCleanup(message.jobId, now());
  if (cleanup.disposition === "busy") return { disposition: "retry", delaySeconds: cleanup.delaySeconds };
  if (cleanup.disposition === "acquired") {
    try {
      await dependencies.vectors.deleteIds(cleanup.vectorIds);
      await dependencies.repository.completeGenerationCleanup(message.jobId, cleanup.cleanupToken, now());
      return { disposition: "retry", delaySeconds: 1 };
    } catch {
      await dependencies.repository.releaseGenerationCleanup(message.jobId, cleanup.cleanupToken, now());
      return { disposition: "retry", delaySeconds: 5 };
    }
  }
  const claim = await dependencies.repository.claimJob(message.jobId, 300, now());
  if (claim.disposition === "busy") return { disposition: "retry", delaySeconds: claim.delaySeconds };
  if (claim.disposition !== "acquired") return { disposition: "ack" };
  const token = claim.leaseToken; let vectorIds: string[] = []; let generationArmed = false; let staged = false; let indexVersion: number | null = null;
  try {
    if (message.kind === "delete") {
      const job = await dependencies.repository.getJob(message.jobId);
      const document = await dependencies.repository.getDocument(message.documentId);
      if (!job || !document) return { disposition: "ack" };
      if (job.indexVersion !== null && document.activeVersion !== job.indexVersion) return { disposition: "ack" };
      const deleteIds = await dependencies.repository.listVectorIds(message.documentId);
      try {
        await dependencies.vectors.deleteIds(deleteIds);
        if (document.r2Key) await dependencies.objectStore.deleteOriginal(document.r2Key);
        await dependencies.repository.completeDeletion(message.jobId, token, job.indexVersion, now());
        return { disposition: "ack" };
      } catch (error) {
        if (error instanceof StaleIngestionClaimError) return { disposition: "ack" };
        try { await dependencies.repository.releaseJob(message.jobId, "delete_retryable", token, now()); }
        catch (releaseError) { if (releaseError instanceof StaleIngestionClaimError) return { disposition: "ack" }; throw releaseError; }
        return { disposition: "retry", delaySeconds: retryDelay(claim.attemptCount) };
      }
    }
    const document = await dependencies.repository.getDocument(message.documentId);
    if (!document || !document.r2Key) throw new PermanentIngestionError("source_not_found");
    const source = await dependencies.objectStore.getOriginal(document.r2Key);
    if (!source) throw new PermanentIngestionError("source_not_found");
    const blob = await source.blob();
    indexVersion = await dependencies.repository.beginVersion(message.jobId, token, now());
    await dependencies.repository.renewJob(message.jobId, token, now());
    const converted = await dependencies.converter.convert({ documentId: document.id, indexVersion, blob, kind: conversionKind(document), name: document.displayName });
    const drafts = (dependencies.chunk ?? chunkDocument)(converted);
    await dependencies.repository.renewJob(message.jobId, token, now());
    const embeddings = await dependencies.embeddings.embed(drafts.map((draft) => draft.text));
    vectorIds = drafts.map((draft) => vectorIdFor(draft.documentId, draft.indexVersion, draft.id, token));
    const chunks = toChunks(drafts, vectorIds, now());
    await dependencies.repository.registerGeneration(message.jobId, token, indexVersion, vectorIds, now()); generationArmed = true;
    await dependencies.repository.stageChunks(message.jobId, token, chunks, now()); staged = true;
    await dependencies.repository.renewJob(message.jobId, token, now());
    await dependencies.vectors.upsert(drafts, embeddings, token);
    await dependencies.repository.renewJob(message.jobId, token, now());
    const stagedCount = await dependencies.repository.countStagedChunks(message.jobId, token, now());
    if (stagedCount !== drafts.length) throw new PermanentIngestionError("staging_count_mismatch");
    await dependencies.repository.publishVersion(message.jobId, token, drafts.length, now());
    return { disposition: "ack" };
  } catch (error) {
    const classified = classify(error);
    if (generationArmed) {
      const authorization = await dependencies.repository.authorizeGenerationCleanup(message.jobId, token, indexVersion!, vectorIds, classified.code, classified.retryable ? "pending" : "failed", now());
      if (authorization.disposition === "published" || authorization.disposition === "stale") return { disposition: "ack" };
      return { disposition: "retry", delaySeconds: classified.retryable ? retryDelay(claim.attemptCount) : 1 };
    }
    if (error instanceof StaleIngestionClaimError) return { disposition: "ack" };
    if (staged) await Promise.allSettled([dependencies.repository.cleanupStaging(message.jobId, token, now())]);
    if (classified.retryable) {
      try { await dependencies.repository.releaseJob(message.jobId, classified.code, token, now()); }
      catch (releaseError) { if (releaseError instanceof StaleIngestionClaimError) return { disposition: "ack" }; throw releaseError; }
      return { disposition: "retry", delaySeconds: retryDelay(claim.attemptCount) };
    }
    try { await dependencies.repository.failJob(message.jobId, classified.code, "permanent", token, now()); }
    catch (failureError) { if (failureError instanceof StaleIngestionClaimError) return { disposition: "ack" }; throw failureError; }
    return { disposition: "ack" };
  }
}

class PermanentIngestionError extends Error { constructor(readonly code: string) { super(code); } }
function classify(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ConversionError || error instanceof EmbeddingError) return { code: error.code, retryable: error.retryable };
  if (error instanceof PermanentIngestionError) return { code: error.code, retryable: false };
  return { code: "ingestion_temporary", retryable: true };
}
function retryDelay(attempt: number): number { return attempt <= 1 ? 5 : attempt === 2 ? 15 : 30; }
function conversionKind(document: KnowledgeDocument): ConversionKind {
  const name = document.displayName.toLowerCase();
  if (document.sourceType === "url" || name.endsWith(".md")) return "markdown";
  if (name.endsWith(".docx")) return "docx"; if (name.endsWith(".txt")) return "text";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpeg"; if (name.endsWith(".png")) return "png";
  return "pdf";
}
function toChunks(drafts: KnowledgeChunkDraft[], vectorIds: string[], createdAt: string): KnowledgeChunk[] {
  return drafts.map((draft, index) => ({ ...draft, vectorId: vectorIds[index]!, createdAt }));
}
