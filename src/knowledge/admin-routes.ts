import type { Context, Hono } from "hono";

import type { Env } from "../config";
import { requireKnowledgeAdmin } from "./admin-auth";
import { ClaimedUploadError, finalizeClaimedUpload } from "./claimed-upload";
import type { IngestionJobDetails, KnowledgeRepository } from "./repository";
import { KnowledgeFileError, validateKnowledgeFile, type ValidatedKnowledgeFile } from "./file-validation";
import type { KnowledgeObjectStore } from "./storage";
import type { IngestionJobMessage } from "./types";
import { KnowledgeUrlError, normalizeKnowledgeUrl, type SafeUrlFetcher } from "./url-safety";

export type KnowledgeReader = Pick<KnowledgeRepository, "listDocuments" | "getDocument">;
export type KnowledgeAdminRepository = KnowledgeReader & Pick<KnowledgeRepository, "claimUpload" | "updateUploadClaim" | "abandonUploadClaim" | "completeUpload" | "failUpload" | "clearUploadClaim" | "createJob" | "findLiveJob" | "findLatestJob" | "markDeleting">;
export type KnowledgeUploadDependencies = {
  repositoryFor: (env: Env) => KnowledgeAdminRepository;
  objectStoreFor: (env: Env) => KnowledgeObjectStore;
  queueFor: (env: Env) => Pick<Queue<IngestionJobMessage>, "send">;
  validateFile?: (file: File) => Promise<ValidatedKnowledgeFile>;
  safeUrlFetcherFor: (env: Env) => SafeUrlFetcher;
  now?: () => Date;
};

export function registerKnowledgeAdminRoutes(
  app: Hono<{ Bindings: Env }>,
  dependencies: KnowledgeUploadDependencies,
): void {
  const { repositoryFor } = dependencies;
  const requireAdmin = requireKnowledgeAdmin();

  app.get("/admin/knowledge/documents", requireAdmin, async (context) => {
    try {
      return context.json({ documents: await repositoryFor(context.env).listDocuments() });
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });

  app.get("/admin/knowledge/documents/:id", requireAdmin, async (context) => {
    try {
      const document = await repositoryFor(context.env).getDocument(context.req.param("id"));
      if (!document) {
        return context.json({
          error: { code: "document_not_found", message: "Document not found" },
        }, 404);
      }
      return context.json({ document });
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });

  app.post("/admin/knowledge/files", requireAdmin, async (context) => {
    const rawKey = context.req.header("Idempotency-Key");
    const key = rawKey?.trim() ?? "";
    if (!key || new TextEncoder().encode(key).byteLength > 128) return context.json({ error: { code: "invalid_idempotency_key", message: "Invalid Idempotency-Key" } }, 400);
    const [documentId, jobId] = await Promise.all([stableUuid("knowledge-document:", key), stableUuid("knowledge-job:", key)]);
    const repository = repositoryFor(context.env);
    try {
      const form = await context.req.formData();
      const files = [...form.entries()].filter(([, value]) => value instanceof File);
      const selected = form.getAll("file");
      if (files.length !== 1 || selected.length !== 1 || !(selected[0] instanceof File)) throw new KnowledgeFileError("single_file_required");
      const file = selected[0];
      const validated = await (dependencies.validateFile ?? validateKnowledgeFile)(file);
      const displayName = sanitizeName(file.name);
      const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
      const contentHash = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const claim = await repository.claimUpload({ id: documentId, sourceType: "file", displayName, sourceUrl: null, r2Key: null, contentHash, createdAt }, jobId, createdAt, validated.extension);
      if (claim.disposition === "resume_queue") {
        try {
          const result = await finalizeClaimedUpload({ documentId, jobId, claim: { disposition: "resume_queue" }, createdAt }, uploadDependencies(context.env, dependencies, repository));
          return context.json(result, 202);
        } catch (error) {
          return claimedUploadFailure(context, error);
        }
      }
      if (claim.disposition !== "winner") return context.json({ documentId, status: "pending" }, 202);
      try {
        const result = await finalizeClaimedUpload({ documentId, jobId, claim, blob: file, displayName, mimeType: validated.mimeType, createdAt }, uploadDependencies(context.env, dependencies, repository));
        return context.json(result, 202);
      } catch (error) {
        return claimedUploadFailure(context, error);
      }
    } catch (error) {
      if (error instanceof KnowledgeFileError) return context.json({ error: { code: error.code, message: errorMessage(error.code) } }, 400);
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });

  app.post("/admin/knowledge/urls", requireAdmin, async (context) => {
    const rawKey = context.req.header("Idempotency-Key"); const key = rawKey?.trim() ?? "";
    if (!key || new TextEncoder().encode(key).byteLength > 128) return context.json({ error: { code: "invalid_idempotency_key", message: "Invalid Idempotency-Key" } }, 400);
    if (context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return invalidRequest(context);
    let body: unknown; try { body = await context.req.json(); } catch { return invalidRequest(context); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as {url?:unknown}).url !== "string") return invalidRequest(context);
    let normalized: string; try { normalized = normalizeKnowledgeUrl((body as {url:string}).url); } catch { return invalidRequest(context); }
    const [documentId, jobId] = await Promise.all([stableUuid("knowledge-document:", key), stableUuid("knowledge-job:", key)]);
    const repository = repositoryFor(context.env); const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
    try {
      const claim = await repository.claimUpload({ id: documentId, sourceType: "url", displayName: new URL(normalized).hostname, sourceUrl: normalized, r2Key: null, contentHash: null, createdAt }, jobId, createdAt, ".md");
      if (claim.disposition === "resume_queue") {
        try {
          const result = await finalizeClaimedUpload({ documentId, jobId, claim: { disposition: "resume_queue" }, createdAt }, uploadDependencies(context.env, dependencies, repository));
          return context.json(result, 202);
        } catch (error) {
          return claimedUploadFailure(context, error);
        }
      }
      if (claim.disposition !== "winner") return context.json({ documentId, status: "pending" }, 202);
      const { token } = claim;
      let article: Awaited<ReturnType<SafeUrlFetcher["fetchStaticArticle"]>>;
      try { article = await dependencies.safeUrlFetcherFor(context.env).fetchStaticArticle(normalized); }
      catch (error) {
        await Promise.allSettled([repository.abandonUploadClaim(documentId, token)]);
        if (error instanceof KnowledgeUrlError) {
          const status = error.code === "source_unavailable" ? 503 : 400;
          const message = error.code === "source_disallowed" ? "Source disallowed" : error.code === "source_unavailable" ? "Source unavailable" : "Invalid source";
          return context.json({ error: { code: error.code, message } }, status);
        }
        return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
      }
      const contentHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(article.html)));
      let updated: boolean;
      try { updated = await repository.updateUploadClaim(documentId, token, { displayName: article.title, sourceUrl: article.finalUrl, contentHash, updatedAt: createdAt }); }
      catch { await Promise.allSettled([repository.abandonUploadClaim(documentId, token)]); return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500); }
      if (!updated) return context.json({ documentId, status: "pending" }, 202);
      try {
        const result = await finalizeClaimedUpload({ documentId, jobId, claim, blob: new Blob([article.html], { type: "text/markdown; charset=utf-8" }), displayName: `${article.title}.md`, mimeType: "text/markdown; charset=utf-8", createdAt }, uploadDependencies(context.env, dependencies, repository));
        return context.json(result, 202);
      } catch (error) {
        return claimedUploadFailure(context, error);
      }
    } catch (error) {
      if (error instanceof KnowledgeUrlError) {
        const status = error.code === "source_unavailable" ? 503 : 400;
        const message = error.code === "source_disallowed" ? "Source disallowed" : error.code === "source_unavailable" ? "Source unavailable" : "Invalid source";
        return context.json({ error: { code: error.code, message } }, status);
      }
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });

  app.post("/admin/knowledge/documents/:id/reindex", requireAdmin, async (context) => {
    try {
      const repository = repositoryFor(context.env);
      const document = await repository.getDocument(context.req.param("id"));
      if (!document) return context.json({ error: { code: "document_not_found", message: "Document not found" } }, 404);
      if (document.status !== "ready") return conflict();
      const live = await repository.findLiveJob(document.id);
      if (live) return conflict();
      const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
      const jobId = crypto.randomUUID();
      await repository.createJob({ id: jobId, documentId: document.id, operation: "reindex", createdAt });
      try { await dependencies.queueFor(context.env).send({ jobId, documentId: document.id, kind: "reindex" }); }
      catch { return context.json({ error: { code: "queue_unavailable", message: "Queue unavailable" } }, 503); }
      return context.json({ jobId, status: "pending" }, 202);
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });

  app.delete("/admin/knowledge/documents/:id", requireAdmin, async (context) => {
    try {
      const repository = repositoryFor(context.env);
      const document = await repository.getDocument(context.req.param("id"));
      if (!document) return context.json({ error: { code: "document_not_found", message: "Document not found" } }, 404);
      const live = await repository.findLiveJob(document.id);
      if (live && live.operation !== "delete") return conflict();
      if (live && live.operation === "delete") return context.json({ jobId: live.id, status: live.status === "processing" ? "pending" : live.status }, 202);
      if (document.status === "deleting") {
        const latestDelete = await repository.findLatestJob(document.id, "delete");
        if (latestDelete) return context.json({ jobId: latestDelete.id, status: latestDelete.status === "processing" ? "pending" : latestDelete.status }, 202);
      }
      const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
      const jobId = crypto.randomUUID();
      await repository.markDeleting(document.id);
      await repository.createJob({ id: jobId, documentId: document.id, operation: "delete", createdAt, indexVersion: document.activeVersion });
      try { await dependencies.queueFor(context.env).send({ jobId, documentId: document.id, kind: "delete" }); }
      catch { return context.json({ error: { code: "queue_unavailable", message: "Queue unavailable" } }, 503); }
      return context.json({ jobId, status: "pending" }, 202);
    } catch {
      return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
    }
  });
}

function invalidRequest(context: Context) { return context.json({ error: { code: "invalid_request", message: "Invalid request" } }, 400); }
function conflict() { return new Response(JSON.stringify({ error: { code: "conflict", message: "Conflict" } }), { status: 409, headers: { "content-type": "application/json" } }); }
function uploadDependencies(env: Env, dependencies: KnowledgeUploadDependencies, repository: KnowledgeAdminRepository) {
  const store: KnowledgeObjectStore = {
    putOriginal: (...input) => dependencies.objectStoreFor(env).putOriginal(...input),
    getOriginal: (key) => dependencies.objectStoreFor(env).getOriginal(key),
    deleteOriginal: (key) => dependencies.objectStoreFor(env).deleteOriginal(key),
  };
  const queue: Pick<Queue<IngestionJobMessage>, "send"> = {
    send: (message) => dependencies.queueFor(env).send(message),
  };
  return { repository, store, queue, now: dependencies.now };
}
function claimedUploadFailure(context: Context, error: unknown) {
  if (error instanceof ClaimedUploadError && error.code === "queue_unavailable") return context.json({ error: { code: "queue_unavailable", message: "Queue unavailable" } }, 503);
  return context.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
}

export async function stableUuid(namespace: string, key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace + key))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = hex(bytes); return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
function hex(value: ArrayBuffer | Uint8Array): string { return [...(value instanceof Uint8Array ? value : new Uint8Array(value))].map((byte) => byte.toString(16).padStart(2,"0")).join(""); }
function sanitizeName(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""); }
function errorMessage(code: KnowledgeFileError["code"]): string { return code === "single_file_required" ? "Single file required" : code.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" "); }
