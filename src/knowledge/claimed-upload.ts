import type { KnowledgeAdminRepository } from "./admin-routes";
import type { KnowledgeObjectStore } from "./storage";
import type { IngestionJobMessage } from "./types";

type WinningUploadClaim = Extract<Awaited<ReturnType<KnowledgeAdminRepository["claimUpload"]>>, { disposition: "winner" }>;

export type ClaimedUploadInput =
  | {
    documentId: string;
    jobId: string;
    claim: WinningUploadClaim;
    blob: Blob;
    displayName: string;
    mimeType: string;
    createdAt: string;
  }
  | {
    documentId: string;
    jobId: string;
    claim: { disposition: "resume_queue" };
    createdAt: string;
  };

export type ClaimedUploadDependencies = {
  repository: Pick<KnowledgeAdminRepository, "completeUpload" | "failUpload" | "clearUploadClaim">;
  store: KnowledgeObjectStore;
  queue: Pick<Queue<IngestionJobMessage>, "send">;
  now?: () => Date;
};

export class ClaimedUploadError extends Error {
  constructor(readonly code: "queue_unavailable" | "upload_failed") {
    super(code);
    this.name = "ClaimedUploadError";
  }
}

export async function finalizeClaimedUpload(
  input: ClaimedUploadInput,
  dependencies: ClaimedUploadDependencies,
): Promise<{ documentId: string; status: "pending" }> {
  const { outcome: _outcome, ...result } = await finalizeClaimedUploadOutcome(input, dependencies);
  return result;
}

export async function finalizeClaimedUploadOutcome(
  input: ClaimedUploadInput,
  dependencies: ClaimedUploadDependencies,
): Promise<{ documentId: string; status: "pending"; outcome: "enqueued" | "fence_lost" }> {
  const result = { documentId: input.documentId, status: "pending" as const };
  const message = { jobId: input.jobId, documentId: input.documentId, kind: "ingest" as const };

  if (input.claim.disposition === "resume_queue") {
    try {
      await dependencies.queue.send(message);
    } catch {
      throw new ClaimedUploadError("queue_unavailable");
    }
    return { ...result, outcome: "enqueued" };
  }

  const winner = input as Extract<ClaimedUploadInput, { claim: WinningUploadClaim }>;
  const { token, r2Key, previousR2Key } = winner.claim;
  try {
    if (previousR2Key && previousR2Key !== r2Key) await Promise.allSettled([dependencies.store.deleteOriginal(previousR2Key)]);
    await dependencies.store.putOriginal(r2Key, winner.blob, { originalName: winner.displayName, mimeType: winner.mimeType });
    const finalized = await dependencies.repository.completeUpload(
      input.documentId,
      { id: input.jobId, documentId: input.documentId, operation: "ingest", createdAt: input.createdAt },
      token,
      input.createdAt,
    );
    if (!finalized) {
      await Promise.allSettled([dependencies.store.deleteOriginal(r2Key)]);
      return { ...result, outcome: "fence_lost" };
    }
  } catch {
    await Promise.allSettled([
      dependencies.repository.failUpload(input.documentId, input.jobId, "upload_failed", nowIso(dependencies), token),
      dependencies.store.deleteOriginal(r2Key),
    ]);
    throw new ClaimedUploadError("upload_failed");
  }

  try {
    await dependencies.queue.send(message);
  } catch {
    await Promise.allSettled([
      dependencies.repository.failUpload(input.documentId, input.jobId, "queue_send_failed", nowIso(dependencies), token),
      dependencies.store.deleteOriginal(r2Key),
    ]);
    throw new ClaimedUploadError("queue_unavailable");
  }

  await dependencies.repository.clearUploadClaim(input.documentId, token, nowIso(dependencies));
  return { ...result, outcome: "enqueued" };
}

function nowIso(dependencies: ClaimedUploadDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}
