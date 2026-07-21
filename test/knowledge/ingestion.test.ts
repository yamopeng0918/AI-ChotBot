import { describe, expect, test, vi } from "vitest";

import { ConversionError } from "../../src/knowledge/converter";
import { EmbeddingError } from "../../src/knowledge/embeddings";
import { processIngestionJob } from "../../src/knowledge/ingestion";
import { StaleIngestionClaimError } from "../../src/knowledge/repository";
import { vectorIdFor } from "../../src/knowledge/vector-store";
import { createWorker } from "../../src/index";

const draft = { id: "chunk", documentId: "doc", indexVersion: 1, text: "hello", pageNumber: 1, paragraphIndex: 0, segmentIndex: 0, sectionPath: "Intro", contentHash: "hash" };

function setup() {
  const order: string[] = [];
  const repository = {
    claimJob: vi.fn(async () => { order.push("claim"); return { disposition: "acquired", leaseToken: "lease", leaseUntil: "later", attemptCount: 1 }; }),
    getDocument: vi.fn(async () => ({ id: "doc", r2Key: "source.pdf", displayName: "source.pdf", sourceType: "file" })),
    beginVersion: vi.fn(async () => { order.push("begin"); return 1; }),
    renewJob: vi.fn(async () => { order.push("renew"); return "later"; }),
    stageChunks: vi.fn(async () => { order.push("stage"); }),
    countStagedChunks: vi.fn(async () => 1),
    claimGenerationCleanup: vi.fn(async () => ({ disposition: "none" })),
    registerGeneration: vi.fn(async () => { order.push("arm"); }),
    authorizeGenerationCleanup: vi.fn(async () => ({ disposition: "authorized" })),
    completeGenerationCleanup: vi.fn(async () => undefined),
    releaseGenerationCleanup: vi.fn(async () => undefined),
    cleanupStaging: vi.fn(async () => { order.push("cleanup-staging"); }),
    publishVersion: vi.fn(async () => { order.push("publish"); }),
    releaseJob: vi.fn(async () => { order.push("release"); }),
    failJob: vi.fn(async () => { order.push("fail"); }),
  };
  const objectStore = { getOriginal: vi.fn(async () => { order.push("r2"); return { blob: async () => new Blob(["source"], { type: "application/pdf" }) }; }) };
  const converter = { convert: vi.fn(async () => { order.push("convert"); return { documentId: "doc", indexVersion: 1, kind: "pdf", name: "source.pdf", tokens: 1, pages: [] }; }) };
  const chunk = vi.fn(() => { order.push("chunk"); return [draft]; });
  const embeddings = { embed: vi.fn(async () => { order.push("embed"); return [Array(1024).fill(0)]; }) };
  const vectors = {
    upsert: vi.fn(async () => { order.push("upsert"); return ["a".repeat(64)]; }),
    deleteIds: vi.fn(async () => { order.push("cleanup-vectors"); }),
  };
  const now = vi.fn(() => new Date("2026-07-21T00:00:00.000Z"));
  return { order, repository, objectStore, converter, chunk, embeddings, vectors, now };
}

describe("processIngestionJob", () => {
  test("builds and atomically publishes a complete staged index in order", async () => {
    const d = setup();
    const vectorId = vectorIdFor("doc", 1, "chunk", "lease");
    await expect(processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).resolves.toEqual({ disposition: "ack" });
    expect(d.order).toEqual(["claim", "r2", "begin", "renew", "convert", "chunk", "renew", "embed", "arm", "stage", "renew", "upsert", "renew", "publish"]);
    expect(d.repository.stageChunks).toHaveBeenCalledWith("job", "lease", [expect.objectContaining({ ...draft, vectorId })], "2026-07-21T00:00:00.000Z");
    expect(d.repository.publishVersion).toHaveBeenCalledWith("job", "lease", 1, "2026-07-21T00:00:00.000Z");
  });

  test.each([
    [new ConversionError("low_quality_output", false), "low_quality_output"],
    [new EmbeddingError("embedding_input_too_long", false), "embedding_input_too_long"],
  ])("records permanent failures and acks", async (failure, code) => {
    const d = setup(); d.converter.convert.mockRejectedValueOnce(failure);
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "ack" });
    expect(d.repository.failJob).toHaveBeenCalledWith("job", code, "permanent", "lease", expect.any(String));
    expect(d.repository.publishVersion).not.toHaveBeenCalled();
  });

  test.each([[1, 5], [2, 15], [3, 30], [4, 30]])("releases retryable attempt %i with bounded delay %i", async (attemptCount, delaySeconds) => {
    const d = setup(); d.repository.claimJob.mockResolvedValueOnce({ disposition: "acquired", leaseToken: "lease", leaseUntil: "later", attemptCount });
    d.embeddings.embed.mockRejectedValueOnce(new EmbeddingError("embedding_upstream", true));
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "retry", delaySeconds });
    expect(d.repository.releaseJob).toHaveBeenCalledWith("job", "embedding_upstream", "lease", expect.any(String));
    expect(d.repository.failJob).not.toHaveBeenCalled();
  });

  test("cleans only the current generation after a stale fence following external upsert", async () => {
    const d = setup(); d.repository.publishVersion.mockRejectedValueOnce(new StaleIngestionClaimError()); d.repository.authorizeGenerationCleanup.mockResolvedValueOnce({ disposition: "stale" } as never);
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "ack" });
    expect(d.vectors.deleteIds).not.toHaveBeenCalled();
    expect(d.repository.cleanupStaging).not.toHaveBeenCalled();
    expect(d.repository.failJob).not.toHaveBeenCalled();
  });

  test("cleans staging and generation vectors after a retryable Vectorize failure without publishing", async () => {
    const d = setup(); d.vectors.upsert.mockRejectedValueOnce(new Error("temporary"));
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "retry", delaySeconds: 5 });
    expect(d.vectors.deleteIds).not.toHaveBeenCalled();
    expect(d.repository.authorizeGenerationCleanup).toHaveBeenCalledWith("job", "lease", 1, [vectorIdFor("doc", 1, "chunk", "lease")], "ingestion_temporary", "pending", expect.any(String));
    expect(d.repository.publishVersion).not.toHaveBeenCalled();
  });

  test("a dedicated cleanup claim deletes only its captured generation before any ingestion reclaim", async () => {
    const d = setup(); d.repository.claimGenerationCleanup.mockResolvedValueOnce({ disposition: "acquired", cleanupToken: "cleanup", vectorIds: ["b".repeat(64)] } as never);
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "retry", delaySeconds: 1 });
    expect(d.vectors.deleteIds).toHaveBeenCalledWith(["b".repeat(64)]);
    expect(d.repository.completeGenerationCleanup).toHaveBeenCalledWith("job", "cleanup", expect.any(String));
    expect(d.repository.claimJob).not.toHaveBeenCalled();
    expect("listStagedVectorIds" in d.repository).toBe(false);
  });

  test("ambiguous publish never deletes a generation D1 reports as published", async () => {
    const d = setup(); d.repository.publishVersion.mockRejectedValueOnce(new Error("ambiguous response"));
    d.repository.authorizeGenerationCleanup.mockResolvedValueOnce({ disposition: "published" } as never);
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "ack" });
    expect(d.repository.authorizeGenerationCleanup).toHaveBeenCalledWith("job", "lease", 1, [vectorIdFor("doc", 1, "chunk", "lease")], "ingestion_temporary", "pending", expect.any(String));
    expect(d.vectors.deleteIds).not.toHaveBeenCalled();
  });

  test("cleanup failure remains retryable even when the ingestion job is terminal", async () => {
    const d = setup(); d.repository.claimGenerationCleanup.mockResolvedValueOnce({ disposition: "acquired", cleanupToken: "cleanup", vectorIds: ["b".repeat(64)] } as never);
    d.vectors.deleteIds.mockRejectedValueOnce(new Error("vectorize down"));
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "retry", delaySeconds: 5 });
    expect(d.repository.releaseGenerationCleanup).toHaveBeenCalledWith("job", "cleanup", expect.any(String));
    expect(d.repository.claimJob).not.toHaveBeenCalled();
  });

  test("a staging failure after arming becomes durable cleanup instead of best-effort row deletion", async () => {
    const d = setup(); d.repository.stageChunks.mockRejectedValueOnce(new Error("d1 interrupted"));
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, d as never)).toEqual({ disposition: "retry", delaySeconds: 5 });
    expect(d.repository.authorizeGenerationCleanup).toHaveBeenCalledWith("job", "lease", 1, [vectorIdFor("doc", 1, "chunk", "lease")], "ingestion_temporary", "pending", expect.any(String));
    expect(d.repository.cleanupStaging).not.toHaveBeenCalled();
    expect(d.repository.releaseJob).not.toHaveBeenCalled();
  });

  test("acks terminal duplicates and retries busy claims without external work", async () => {
    const terminal = setup(); terminal.repository.claimJob.mockResolvedValueOnce({ disposition: "completed", ack: true } as never);
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, terminal as never)).toEqual({ disposition: "ack" });
    expect(terminal.objectStore.getOriginal).not.toHaveBeenCalled();
    const busy = setup(); busy.repository.claimJob.mockResolvedValueOnce({ disposition: "busy", delaySeconds: 27 } as never);
    expect(await processIngestionJob({ jobId: "job", documentId: "doc", kind: "ingest" }, busy as never)).toEqual({ disposition: "retry", delaySeconds: 27 });
  });
});

describe("worker queue dispatch", () => {
  test("dispatches mixed LINE and knowledge messages by shape and retries unknown shapes", async () => {
    const ingestion = setup();
    const questions = { claim: vi.fn().mockResolvedValue({ state: "completed" }), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(), purgeExpired: vi.fn() };
    const worker = createWorker({ ingestion: ingestion as never, questions });
    const knowledge = { body: { jobId: "job", documentId: "doc", kind: "ingest" }, ack: vi.fn(), retry: vi.fn() };
    const line = { body: { webhookEventId: "event", replyToken: "reply", groupId: "group", userId: null, messageId: "message", text: "question", timestamp: 1, receivedAt: "2026-07-21T00:00:00.000Z" }, ack: vi.fn(), retry: vi.fn() };
    const unknown = { body: { jobId: "job" }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [knowledge, line, unknown] } as never, {} as never, {} as never);
    expect(ingestion.repository.claimJob).toHaveBeenCalledOnce(); expect(knowledge.ack).toHaveBeenCalledOnce();
    expect(questions.claim).toHaveBeenCalledOnce(); expect(line.ack).toHaveBeenCalledOnce();
    expect(unknown.retry).toHaveBeenCalledWith({ delaySeconds: 1 }); expect(unknown.ack).not.toHaveBeenCalled();
  });

  test("retries delete messages for their owning lifecycle task without rebuilding", async () => {
    const ingestion = setup(); const worker = createWorker({ ingestion: ingestion as never });
    const message = { body: { jobId: "job", documentId: "doc", kind: "delete" }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] } as never, {} as never, {} as never);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(ingestion.repository.claimJob).not.toHaveBeenCalled();
  });
});
