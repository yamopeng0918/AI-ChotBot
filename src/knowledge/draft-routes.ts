import type { Context, Hono } from "hono";

import type { Env } from "../config";
import { requireKnowledgeAdmin } from "./admin-auth";
import { claimedUploadDependencies, stableUuid, type KnowledgeAdminRepository } from "./admin-routes";
import { ClaimedUploadError, finalizeClaimedUpload } from "./claimed-upload";
import type { KnowledgeDraft, KnowledgeDraftRepository, KnowledgeDraftStatus } from "./drafts";
import type { KnowledgeObjectStore } from "./storage";
import type { IngestionJobMessage } from "./types";

export type KnowledgeDraftReviewRepository = Pick<KnowledgeDraftRepository, "list" | "get" | "approve" | "reject" | "purgeExpired">;
export type KnowledgeDraftRouteDependencies = {
  draftsFor: (env: Env) => KnowledgeDraftReviewRepository;
  knowledgeFor: (env: Env) => Pick<KnowledgeAdminRepository, "claimUpload" | "completeUpload" | "failUpload" | "clearUploadClaim">;
  objectStoreFor: (env: Env) => KnowledgeObjectStore;
  queueFor: (env: Env) => Pick<Queue<IngestionJobMessage>, "send">;
  now?: () => Date;
};

export function registerKnowledgeDraftRoutes(app: Hono<{ Bindings: Env }>, dependencies: KnowledgeDraftRouteDependencies): void {
  const requireAdmin = requireKnowledgeAdmin();

  app.get("/admin/knowledge/drafts", requireAdmin, async (context) => {
    try {
      const status = draftStatus(context.req.query("status"));
      if (!status) return invalidRequest(context);
      const limit = boundedLimit(context.req.query("limit"));
      const drafts = await dependencies.draftsFor(context.env).list(status, limit);
      return context.json({ drafts: drafts.map(summary) });
    } catch {
      return internalError(context);
    }
  });

  app.get("/admin/knowledge/drafts/:id", requireAdmin, async (context) => {
    try {
      const draft = await dependencies.draftsFor(context.env).get(context.req.param("id"));
      if (!draft) return notFound(context);
      return context.json({ draft });
    } catch {
      return internalError(context);
    }
  });

  app.post("/admin/knowledge/drafts/:id/approve", requireAdmin, async (context) => {
    try {
      return await approveDraft(context, dependencies);
    } catch (error) {
      if (error instanceof ClaimedUploadError && error.code === "queue_unavailable") {
        return context.json({ error: { code: "queue_unavailable", message: "Queue unavailable" } }, 503);
      }
      return internalError(context);
    }
  });

  app.post("/admin/knowledge/drafts/:id/reject", requireAdmin, async (context) => {
    try {
      const repository = dependencies.draftsFor(context.env);
      const result = await repository.reject(context.req.param("id"), currentTime(dependencies));
      if (result === "not_found") return notFound(context);
      if (result === "conflict") return conflict(context);
      const draft = await repository.get(context.req.param("id"));
      if (!draft) return notFound(context);
      return context.json({ draft: transitionView(draft) });
    } catch {
      return internalError(context);
    }
  });
}

async function approveDraft(context: Context<{ Bindings: Env }>, dependencies: KnowledgeDraftRouteDependencies) {
  const drafts = dependencies.draftsFor(context.env);
  const id = context.req.param("id") ?? "";
  const draft = await drafts.get(id);
  if (!draft) return notFound(context);
  if (draft.status === "rejected") return conflict(context);
  if (draft.status === "approved") return context.json({ draft: transitionView(draft) });

  const key = `knowledge-draft:${draft.id}`;
  const [documentId, jobId, contentHash] = await Promise.all([
    stableUuid("knowledge-document:", key), stableUuid("knowledge-job:", key), sha256(draft.markdown),
  ]);
  const createdAt = currentTime(dependencies);
  const displayName = `${safeTopic(draft.topic)}.md`;
  const knowledge = dependencies.knowledgeFor(context.env);
  const claim = await knowledge.claimUpload({
    id: documentId, sourceType: "file", displayName, sourceUrl: null, r2Key: null, contentHash, createdAt,
  }, jobId, createdAt, ".md");

  if (claim.disposition !== "winner") {
    if (claim.disposition === "busy") return conflict(context);
    if (claim.disposition === "duplicate") return persistApproval(context, drafts, draft.id, documentId, createdAt, 200);
    await finalizeClaimedUpload(
      { documentId, jobId, claim: { disposition: "resume_queue" }, createdAt },
      claimedUploadDependencies(context.env, dependencies, knowledge),
    );
    return persistApproval(context, drafts, draft.id, documentId, createdAt, 202);
  }

  await finalizeClaimedUpload({
    documentId, jobId, claim,
    blob: new Blob([draft.markdown], { type: "text/markdown; charset=utf-8" }),
    displayName, mimeType: "text/markdown; charset=utf-8", createdAt,
  }, claimedUploadDependencies(context.env, dependencies, knowledge));
  return persistApproval(context, drafts, draft.id, documentId, createdAt, 202);
}

async function persistApproval(
  context: Context<{ Bindings: Env }>, drafts: KnowledgeDraftReviewRepository,
  id: string, documentId: string, reviewedAt: string, successStatus: 200 | 202,
) {
  const result = await drafts.approve(id, documentId, reviewedAt);
  if (result === "not_found") return notFound(context);
  const persisted = await drafts.get(id);
  if (!persisted) return notFound(context);
  if (result === "conflict" && (persisted.status !== "approved" || persisted.documentId !== documentId)) return conflict(context);
  return context.json({ draft: transitionView(persisted) }, successStatus);
}

function summary(draft: KnowledgeDraft) {
  return {
    id: draft.id, status: draft.status, topic: draft.topic, sourceCount: draft.sources.length,
    documentId: draft.documentId, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
    expiresAt: draft.expiresAt, reviewedAt: draft.reviewedAt,
  };
}

function transitionView(draft: KnowledgeDraft) {
  return { id: draft.id, status: draft.status, documentId: draft.documentId };
}

function draftStatus(value: string | undefined): KnowledgeDraftStatus | null {
  if (value === undefined || value === "") return "pending";
  return value === "pending" || value === "approved" || value === "rejected" ? value : null;
}

function boundedLimit(value: string | undefined): number {
  const parsed = Number(value ?? 20);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function safeTopic(value: string): string {
  const sanitized = value
    .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]/gu, "")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = truncateUtf8(sanitized, 251).replace(/[. ]+$/g, "");
  return bounded || "knowledge-card";
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > maximumBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentTime(dependencies: KnowledgeDraftRouteDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function invalidRequest(context: Context) { return context.json({ error: { code: "invalid_request", message: "Invalid request" } }, 400); }
function notFound(context: Context) { return context.json({ error: { code: "draft_not_found", message: "Draft not found" } }, 404); }
function conflict(context: Context) { return context.json({ error: { code: "conflict", message: "Conflict" } }, 409); }
function internalError(context: Context) { return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500); }
