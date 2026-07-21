import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { KnowledgeUrlError } from "../../src/knowledge/url-safety";

function setup(fetchError?: KnowledgeUrlError) {
  const order: string[] = [];
  const repository = {
    listDocuments: vi.fn(), getDocument: vi.fn(),
    claimUpload: vi.fn(async () => { order.push("claim"); return { disposition: "winner", token: "token", r2Key: "snapshot.md", previousR2Key: null }; }),
    completeUpload: vi.fn(async () => { order.push("complete"); return true; }), failUpload: vi.fn(), clearUploadClaim: vi.fn(),
  };
  const safeUrlFetcher = { fetchStaticArticle: vi.fn(async () => { order.push("fetch"); if (fetchError) throw fetchError; return { finalUrl: "https://example.com/b?z=1&a=2", title: "Article", html: "# Safe\n[link](https://other.example/)<script>alert(1)</script>", fetchedAt: "2026-07-20T00:00:00.000Z" }; }) };
  const objectStore = { putOriginal: vi.fn(async () => order.push("r2")), getOriginal: vi.fn(), deleteOriginal: vi.fn() };
  const ingestionQueue = { send: vi.fn(async () => order.push("queue")) };
  const worker = createWorker({ knowledge: repository as never, safeUrlFetcher, objectStore: objectStore as never, ingestionQueue: ingestionQueue as never, now: () => new Date("2026-07-20T00:00:00Z") });
  const request = (body: unknown = { url: "HTTPS://Example.COM:443/a/../b?z=1&a=2#x" }, contentType = "application/json") => worker.fetch(new Request("https://worker.test/admin/knowledge/urls", { method: "POST", headers: { authorization: "Bearer admin", "Idempotency-Key": "url-request", "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) }), { ADMIN_API_TOKEN: "admin" } as Env, {} as ExecutionContext);
  return { order, repository, safeUrlFetcher, objectStore, ingestionQueue, request };
}

describe("POST /admin/knowledge/urls", () => {
  test("stores immutable Markdown then finalizes and enqueues IDs only", async () => {
    const d = setup(); const response = await d.request(); expect(response.status).toBe(202);
    const body = await response.json() as {documentId:string,status:string}; expect(body.status).toBe("pending");
    expect(d.order).toEqual(["fetch", "claim", "r2", "complete", "queue"]);
    expect(d.safeUrlFetcher.fetchStaticArticle).toHaveBeenCalledWith("https://example.com/b?z=1&a=2");
    expect(d.repository.claimUpload).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "url", sourceUrl: "https://example.com/b?z=1&a=2", displayName: "Article", contentHash: expect.any(String) }), expect.any(String), "2026-07-20T00:00:00.000Z", ".md");
    const blob = (d.objectStore.putOriginal.mock.calls as unknown as [string, Blob, object][])[0]![1]; expect(await blob.text()).toContain("<script>alert(1)</script>");
    expect(d.objectStore.putOriginal).toHaveBeenCalledWith("snapshot.md", expect.any(Blob), { originalName: "Article.md", mimeType: "text/markdown; charset=utf-8" });
    expect(d.ingestionQueue.send).toHaveBeenCalledWith({ jobId: expect.any(String), documentId: body.documentId, operation: "ingest" });
    expect(JSON.stringify(d.ingestionQueue.send.mock.calls)).not.toContain("Safe");
  });

  test("provider failure creates no document or snapshot", async () => {
    const d = setup(new KnowledgeUrlError("source_disallowed")); const response = await d.request();
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: "source_disallowed", message: "Source disallowed" } });
    expect(d.repository.claimUpload).not.toHaveBeenCalled(); expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
  });

  test.each([["text/plain", "{}"], ["application/json", []], ["application/json", {}], ["application/json", {url:"https://example.com",extra:true}], ["application/json", {url:4}]])("rejects invalid exact JSON", async (contentType, body) => {
    const d = setup(); const response = await d.request(body, contentType as string); expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Invalid request" } }); expect(d.safeUrlFetcher.fetchStaticArticle).not.toHaveBeenCalled();
  });
});
