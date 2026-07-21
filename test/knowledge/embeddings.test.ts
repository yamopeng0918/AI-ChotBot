import { describe, expect, test, vi } from "vitest";

import { EmbeddingError, EmbeddingService } from "../../src/knowledge/embeddings";
import { KnowledgeVectorStore, vectorIdFor } from "../../src/knowledge/vector-store";

const vector = (value = 0) => Array.from({ length: 1024 }, () => value);

describe("EmbeddingService", () => {
  test("uses bge-m3 and batches at 32 while preserving output order", async () => {
    const run = vi.fn(async (_model: string, input: { text: string[] }) => ({ data: input.text.map((text) => vector(Number(text))) }));
    const service = new EmbeddingService({ run });
    const result = await service.embed(Array.from({ length: 65 }, (_, index) => String(index)));
    expect(run.mock.calls.map((call) => [call[0], call[1].text.length])).toEqual([
      ["@cf/baai/bge-m3", 32], ["@cf/baai/bge-m3", 32], ["@cf/baai/bge-m3", 1],
    ]);
    expect(result.map((item) => item[0])).toEqual(Array.from({ length: 65 }, (_, index) => index));
  });

  test.each([
    [{ data: [vector()] }, 2, "embedding_count_mismatch"],
    [{ data: [[1, 2, 3]] }, 1, "embedding_dimension_mismatch"],
    [{ data: [vector(Number.NaN)] }, 1, "embedding_non_finite"],
    [{ embeddings: [vector()] }, 1, "embedding_invalid_response"],
  ])("rejects malformed provider response %#", async (response, inputs, code) => {
    const service = new EmbeddingService({ run: vi.fn().mockResolvedValue(response) });
    await expect(service.embed(Array.from({ length: inputs }, () => "x"))).rejects.toMatchObject({ code, retryable: false });
  });

  test("rejects text over 8,000 Unicode code points without provider access", async () => {
    const run = vi.fn(); const service = new EmbeddingService({ run });
    await expect(service.embed(["😀".repeat(8001)])).rejects.toMatchObject({ code: "embedding_input_too_long", retryable: false });
    expect(run).not.toHaveBeenCalled();
  });

  test("cancels a timed out request and classifies provider failures", async () => {
    let rejectTimeout!: (error: EmbeddingError) => void; const cancel = vi.fn();
    const timeoutService = new EmbeddingService({ run: vi.fn(() => new Promise(() => {})) }, {
      schedule: (milliseconds, reject) => { expect(milliseconds).toBe(10_000); rejectTimeout = reject; return cancel; },
    });
    const pending = timeoutService.embed(["x"]); rejectTimeout(new EmbeddingError("embedding_timeout", true));
    await expect(pending).rejects.toMatchObject({ code: "embedding_timeout", retryable: true });
    expect(cancel).toHaveBeenCalledOnce();

    for (const [error, code, retryable] of [[{ status: 429 }, "embedding_rate_limited", true], [{ status: 503 }, "embedding_upstream", true], [{ status: 400 }, "embedding_failed", false]] as const) {
      await expect(new EmbeddingService({ run: vi.fn().mockRejectedValue(error) }).embed(["x"]))
        .rejects.toMatchObject({ code, retryable });
    }
  });
});

describe("KnowledgeVectorStore", () => {
  test("creates fenced 64-hex IDs, exact metadata, and batches upserts at 1,000", async () => {
    const index = { upsert: vi.fn(), query: vi.fn(), deleteByIds: vi.fn() };
    const store = new KnowledgeVectorStore(index);
    const chunks = Array.from({ length: 1001 }, (_, index) => ({ id: `chunk-${index}`, documentId: "doc", indexVersion: 2 }));
    const ids = await store.upsert(chunks, chunks.map(() => vector()), "lease-token");
    expect(index.upsert.mock.calls.map(([items]) => items.length)).toEqual([1000, 1]);
    expect(ids.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(index.upsert.mock.calls[0]![0][0]).toEqual({ id: ids[0], values: vector(), metadata: { documentId: "doc", chunkId: "chunk-0", indexVersion: 2 } });
    expect(await vectorIdFor("doc", 2, "chunk-0", "lease-token")).toBe(ids[0]);
    expect(await vectorIdFor("doc", 2, "chunk-0", "other-token")).not.toBe(ids[0]);
  });

  test("validates everything before the first Vectorize write", async () => {
    const index = { upsert: vi.fn(), query: vi.fn(), deleteByIds: vi.fn() };
    const store = new KnowledgeVectorStore(index);
    await expect(store.upsert([{ id: "chunk", documentId: "doc", indexVersion: 1 }], [[Infinity]], "lease"))
      .rejects.toThrow("vector dimension");
    expect(index.upsert).not.toHaveBeenCalled();
  });

  test("queries and deletes only requested document/version filters", async () => {
    const index = { upsert: vi.fn(), query: vi.fn().mockResolvedValue({ matches: [] }), deleteByIds: vi.fn() };
    const ids = vi.fn(async (_documentId: string, version?: number) => version ? ["a".repeat(64)] : ["a".repeat(64), "b".repeat(64)]);
    const store = new KnowledgeVectorStore(index, ids);
    await store.query(vector(), 5, { documentId: "doc", indexVersion: 3 });
    await store.deleteVersion("doc", 3); await store.deleteDocument("doc");
    expect(index.query).toHaveBeenCalledWith(vector(), { topK: 5, returnMetadata: "all", filter: { documentId: "doc", indexVersion: 3 } });
    expect(ids.mock.calls).toEqual([["doc", 3], ["doc"]]);
    expect(index.deleteByIds).toHaveBeenNthCalledWith(1, ["a".repeat(64)]);
    expect(index.deleteByIds).toHaveBeenNthCalledWith(2, ["a".repeat(64), "b".repeat(64)]);
  });
});
