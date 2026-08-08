import { describe, expect, test, vi } from "vitest";

import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import type { KnowledgeDraft } from "../../src/knowledge/drafts";
import type { IngestionJobMessage } from "../../src/knowledge/types";
import { stableUuid } from "../../src/knowledge/admin-routes";

const now = new Date("2026-08-08T00:00:00.000Z");
const pending: KnowledgeDraft = {
  id: "draft-1", status: "pending", topic: "跑步補水", markdown: "# 跑步補水\n\n## 重點\n\n適量補水。",
  sources: [{ title: "Official", url: "https://example.gov/run", retrievedAt: now.toISOString() }],
  dedupeKey: "dedupe-1", documentId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  expiresAt: "2026-11-06T00:00:00.000Z", reviewedAt: null,
};

function setup(options: { queueFails?: boolean; topic?: string; markdown?: string; claimDisposition?: "winner" | "resume_queue" | "duplicate"; complete?: boolean } = {}) {
  let draft = { ...structuredClone(pending), ...(options.topic === undefined ? {} : { topic: options.topic }), ...(options.markdown === undefined ? {} : { markdown: options.markdown }) };
  const drafts = {
    list: vi.fn(async (_status: string, _limit: number) => [draft]),
    get: vi.fn(async (id: string) => id === draft.id ? structuredClone(draft) : null),
    reserveApproval: vi.fn(async (id: string, documentId: string, reservedAt: string) => {
      if (id !== draft.id) return "not_found" as const;
      if (draft.status === "approved") return draft.documentId === documentId ? "approved" as const : "conflict" as const;
      if (draft.status === "rejected" || (draft.documentId !== null && draft.documentId !== documentId)) return "conflict" as const;
      draft = { ...draft, documentId, updatedAt: reservedAt };
      return "reserved" as const;
    }),
    releaseApproval: vi.fn(async (id: string, documentId: string, releasedAt: string) => {
      if (id !== draft.id || draft.status !== "pending" || draft.documentId !== documentId) return false;
      draft = { ...draft, documentId: null, updatedAt: releasedAt };
      return true;
    }),
    approve: vi.fn(async (id: string, documentId: string, reviewedAt: string) => {
      if (id !== draft.id) return "not_found" as const;
      if (draft.status === "rejected") return "conflict" as const;
      draft = { ...draft, status: "approved", documentId, reviewedAt, updatedAt: reviewedAt };
      return "approved" as const;
    }),
    reject: vi.fn(async (id: string, reviewedAt: string) => {
      if (id !== draft.id) return "not_found" as const;
      if (draft.status === "approved" || (draft.status === "pending" && draft.documentId !== null)) return "conflict" as const;
      draft = { ...draft, status: "rejected", reviewedAt, updatedAt: reviewedAt };
      return "rejected" as const;
    }),
  };
  const knowledge = {
    claimUpload: vi.fn(async (_document: unknown, _jobId: string) => options.claimDisposition && options.claimDisposition !== "winner"
      ? { disposition: options.claimDisposition }
      : { disposition: "winner" as const, token: "claim", r2Key: "generated.md", previousR2Key: null }),
    completeUpload: vi.fn(async () => options.complete ?? true), failUpload: vi.fn(async () => true), clearUploadClaim: vi.fn(async () => true),
  };
  const objectStore = {
    putOriginal: vi.fn(async () => undefined), getOriginal: vi.fn(), deleteOriginal: vi.fn(async () => undefined),
  };
  const ingestionQueue = { send: vi.fn(async (_message: IngestionJobMessage) => { if (options.queueFails) throw new Error("provider secret"); return {} as QueueSendResponse; }) };
  const worker = createWorker({ now: () => now, draftReviews: drafts as never, knowledge: knowledge as never, objectStore, ingestionQueue: ingestionQueue as never });
  const env = { ADMIN_API_TOKEN: "admin-secret" } as Env;
  const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://worker.test${path}`, {
    ...init, headers: { authorization: "Bearer admin-secret", ...init.headers },
  }) as never, env, {} as ExecutionContext);
  return { drafts, knowledge, objectStore, ingestionQueue, request, current: () => draft };
}

describe("knowledge draft review API", () => {
  test.each([
    ["GET", "/admin/knowledge/drafts"], ["GET", "/admin/knowledge/drafts/draft-1"],
    ["POST", "/admin/knowledge/drafts/draft-1/approve"], ["POST", "/admin/knowledge/drafts/draft-1/reject"],
  ])("requires the shared bearer guard for %s %s", async (method, path) => {
    const d = setup();
    for (const authorization of [undefined, "Bearer wrong"]) {
      const response = await d.request(path, { method, headers: authorization ? { authorization } : { authorization: "" } });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    }
    const response = await d.request(path, { method });
    expect(response.status).not.toBe(401);
  });

  test("lists bounded pending summaries and returns full detail", async () => {
    const d = setup();
    const list = await d.request("/admin/knowledge/drafts?status=pending&limit=9999");
    expect(list.status).toBe(200);
    expect(d.drafts.list).toHaveBeenCalledWith("pending", 100);
    expect(await list.json()).toEqual({ drafts: [{
      id: "draft-1", status: "pending", topic: "跑步補水", sourceCount: 1,
      documentId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: "2026-11-06T00:00:00.000Z", reviewedAt: null,
    }] });
    const detail = await d.request("/admin/knowledge/drafts/draft-1");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ draft: pending });
  });

  test("returns a sanitized 404 for an unknown draft", async () => {
    const d = setup();
    for (const [path, method] of [
      ["/admin/knowledge/drafts/missing", "GET"],
      ["/admin/knowledge/drafts/missing/approve", "POST"],
      ["/admin/knowledge/drafts/missing/reject", "POST"],
    ] as const) {
      const response = await d.request(path, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "draft_not_found", message: "Draft not found" } });
    }
  });

  test("approves through Markdown upload and repeated approval returns the same document without another job", async () => {
    const d = setup();
    const first = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { draft: { documentId: string } };
    expect(firstBody).toEqual({ draft: { id: "draft-1", status: "approved", documentId: expect.any(String) } });
    expect(d.objectStore.putOriginal).toHaveBeenCalledWith(expect.stringMatching(/\.md$/), expect.any(Blob), {
      originalName: expect.stringMatching(/\.md$/), mimeType: "text/markdown; charset=utf-8",
    });
    const second = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ draft: { id: "draft-1", status: "approved", documentId: firstBody.draft.documentId } });
    expect(d.ingestionQueue.send).toHaveBeenCalledOnce();
  });

  test.each([
    ["evil controls", `safe\u202Ename\u2066/../../bad:*?\"<>|`],
    ["all blank", ` \t\n\u200B\u2066 `],
    ["all illegal", `<>:\"/\\|?*\u202E\u2066`],
    ["Unicode format controls", `跑\u200B步\u200D補\u202E水\u2066`],
    ["overlong Unicode", "跑".repeat(120)],
  ])("creates a bounded safe Markdown filename for %s", async (_label, topic) => {
    const d = setup({ topic });
    const response = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(response.status).toBe(202);
    const displayName = (d.knowledge.claimUpload.mock.calls[0]![0] as { displayName: string }).displayName;
    expect(displayName).toMatch(/\.md$/);
    expect(new TextEncoder().encode(displayName).byteLength).toBeLessThanOrEqual(255);
    expect(displayName).not.toMatch(/[\p{Cc}\p{Cf}\\/:*?"<>|]/u);
    if (_label.startsWith("all ")) expect(displayName).toBe("knowledge-card.md");
  });

  test("claims the generated card with its exact SHA-256 content hash", async () => {
    const markdown = "# 精確內容\n\n不可改寫";
    const d = setup({ markdown });
    await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    const claimed = d.knowledge.claimUpload.mock.calls[0]![0] as { contentHash: string };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
    const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(claimed.contentHash).toBe(expected);
  });

  test("resume_queue does not initialize R2 and a synchronous Queue factory failure is a safe 503", async () => {
    const d = setup({ claimDisposition: "resume_queue" });
    const objectStoreFactory = vi.fn(() => d.objectStore);
    const worker = createWorker({
      now: () => now, draftReviews: d.drafts as never, knowledge: d.knowledge as never,
      objectStore: objectStoreFactory, ingestionQueue: undefined,
    });
    const env = { ADMIN_API_TOKEN: "admin-secret" } as Env;
    Object.defineProperty(env, "INGESTION_QUEUE", { get() { throw new Error("Queue binding secret"); } });
    const response = await worker.fetch(new Request("https://worker.test/admin/knowledge/drafts/draft-1/approve", {
      method: "POST", headers: { authorization: "Bearer admin-secret" },
    }) as never, env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(objectStoreFactory).not.toHaveBeenCalled();
  });

  test("resume_queue publishes the reserved draft with stable IDs without writing R2", async () => {
    const d = setup({ claimDisposition: "resume_queue" });
    const response = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(response.status).toBe(202);
    expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
    expect(d.ingestionQueue.send).toHaveBeenCalledOnce();
    expect(d.current()).toMatchObject({ status: "approved", documentId: expect.any(String) });
  });

  test("duplicate upload state finalizes the reservation without another R2 write or Queue message", async () => {
    const d = setup({ claimDisposition: "duplicate" });
    const first = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(first.status).toBe(200);
    const body = await first.json();
    const repeated = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(await repeated.json()).toEqual(body);
    expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
    expect(d.ingestionQueue.send).not.toHaveBeenCalled();
    expect(d.knowledge.claimUpload).toHaveBeenCalledOnce();
  });

  test("a synchronous Queue factory failure after a winning upload fails and cleans up safely", async () => {
    const d = setup();
    const worker = createWorker({
      now: () => now, draftReviews: d.drafts as never, knowledge: d.knowledge as never,
      objectStore: d.objectStore, ingestionQueue: undefined,
    });
    const env = { ADMIN_API_TOKEN: "admin-secret" } as Env;
    Object.defineProperty(env, "INGESTION_QUEUE", { get() { throw new Error("Queue binding secret"); } });
    const response = await worker.fetch(new Request("https://worker.test/admin/knowledge/drafts/draft-1/approve", {
      method: "POST", headers: { authorization: "Bearer admin-secret" },
    }) as never, env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(d.knowledge.failUpload).toHaveBeenCalledOnce();
    expect(d.objectStore.deleteOriginal).toHaveBeenCalledWith("generated.md");
    expect(d.current().status).toBe("pending");
  });

  test("keeps a draft pending after Queue failure and retries the same document and job IDs", async () => {
    const d = setup({ queueFails: true });
    const first = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: { code: "queue_unavailable", message: "Queue unavailable" } });
    expect(d.current()).toMatchObject({ status: "pending", documentId: null });
    expect(d.drafts.releaseApproval).toHaveBeenCalledOnce();
    const firstClaim = d.knowledge.claimUpload.mock.calls[0]!;
    const firstDocument = firstClaim[0] as { id: string };
    const firstMessage = d.ingestionQueue.send.mock.calls[0]![0];
    d.ingestionQueue.send.mockImplementationOnce(async () => ({} as QueueSendResponse));
    const retry = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(retry.status).toBe(202);
    expect((d.knowledge.claimUpload.mock.calls[1]![0] as { id: string }).id).toBe(firstDocument.id);
    expect(d.knowledge.claimUpload.mock.calls[1]![1]).toBe(firstClaim[1]);
    expect(d.ingestionQueue.send.mock.calls[1]![0]).toEqual(firstMessage);
  });

  test("does not approve or enqueue when completeUpload loses its fence", async () => {
    const d = setup({ complete: false });
    const response = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(response.status).toBe(409);
    expect(d.ingestionQueue.send).not.toHaveBeenCalled();
    expect(d.drafts.approve).not.toHaveBeenCalled();
    expect(d.drafts.releaseApproval).not.toHaveBeenCalled();
    expect(d.current()).toMatchObject({ status: "pending", documentId: expect.any(String) });
  });

  test("reservation wins an approve versus reject interleaving", async () => {
    const d = setup();
    d.knowledge.claimUpload.mockImplementationOnce(async (_document, _jobId) => {
      await d.drafts.reject("draft-1", "2026-08-08T00:00:01.000Z");
      return { disposition: "winner" as const, token: "claim", r2Key: "generated.md", previousR2Key: null };
    });
    const response = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(response.status).toBe(202);
    expect(d.current()).toMatchObject({ status: "approved", documentId: expect.any(String) });
  });

  test("keeps the reservation when D1 approval fails after Queue send succeeds", async () => {
    const d = setup();
    d.drafts.approve.mockRejectedValueOnce(new Error("D1 provider secret"));

    const response = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
    expect(d.ingestionQueue.send).toHaveBeenCalledOnce();
    expect(d.drafts.releaseApproval).not.toHaveBeenCalled();
    expect(d.current()).toMatchObject({ status: "pending", documentId: expect.any(String) });
    const reject = await d.request("/admin/knowledge/drafts/draft-1/reject", { method: "POST" });
    expect(reject.status).toBe(409);
    expect(d.current()).toMatchObject({ status: "pending", documentId: expect.any(String) });
  });

  test("returns the persisted approval when marking loses a race without enqueueing another job", async () => {
    const d = setup();
    const documentId = await stableUuid("knowledge-document:", "knowledge-draft:draft-1");
    const approved = { ...pending, status: "approved" as const, documentId, reviewedAt: now.toISOString() };
    d.drafts.get.mockResolvedValueOnce(pending).mockResolvedValueOnce(approved);
    d.drafts.approve.mockResolvedValueOnce("conflict");
    const response = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ draft: { id: "draft-1", status: "approved", documentId } });
    expect(d.ingestionQueue.send).toHaveBeenCalledOnce();
  });

  test("rejects idempotently and conflicts with the opposite terminal transition", async () => {
    const d = setup();
    expect((await d.request("/admin/knowledge/drafts/draft-1/reject", { method: "POST" })).status).toBe(200);
    expect((await d.request("/admin/knowledge/drafts/draft-1/reject", { method: "POST" })).status).toBe(200);
    const conflict = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "conflict", message: "Conflict" } });
  });

  test("rejecting an approved draft conflicts", async () => {
    const d = setup();
    await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect((await d.request("/admin/knowledge/drafts/draft-1/reject", { method: "POST" })).status).toBe(409);
  });

  test("sanitizes repository, storage, and Queue failures", async () => {
    const d = setup();
    d.drafts.list.mockRejectedValueOnce(new Error("D1 secret detail"));
    const internal = await d.request("/admin/knowledge/drafts");
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain("secret");
    d.objectStore.putOriginal.mockRejectedValueOnce(new Error("R2 secret detail"));
    const upload = await d.request("/admin/knowledge/drafts/draft-1/approve", { method: "POST" });
    expect(upload.status).toBe(500);
    expect(JSON.stringify(await upload.json())).not.toContain("secret");
  });
});
