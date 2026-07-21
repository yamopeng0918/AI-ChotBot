import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { KnowledgeUrlError } from "../../src/knowledge/url-safety";

function setup(fetchError?: KnowledgeUrlError) {
  const order: string[] = [];
  const repository = {
    listDocuments: vi.fn(), getDocument: vi.fn(),
    claimUpload: vi.fn(async () => { order.push("claim"); return { disposition: "winner", token: "token", r2Key: "snapshot.md", previousR2Key: null }; }),
    updateUploadClaim: vi.fn(async () => { order.push("update"); return true; }),
    completeUpload: vi.fn(async () => { order.push("complete"); return true; }), failUpload: vi.fn(async () => { order.push("fail"); }), clearUploadClaim: vi.fn(),
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
    expect(d.order).toEqual(["claim", "fetch", "update", "r2", "complete", "queue"]);
    expect(d.safeUrlFetcher.fetchStaticArticle).toHaveBeenCalledWith("https://example.com/b?z=1&a=2");
    expect(d.repository.claimUpload).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "url", sourceUrl: "https://example.com/b?z=1&a=2", displayName: "example.com", contentHash: null }), expect.any(String), "2026-07-20T00:00:00.000Z", ".md");
    expect(d.repository.updateUploadClaim).toHaveBeenCalledWith(expect.any(String), "token", expect.objectContaining({ displayName: "Article", sourceUrl: "https://example.com/b?z=1&a=2", contentHash: expect.any(String) }));
    const blob = (d.objectStore.putOriginal.mock.calls as unknown as [string, Blob, object][])[0]![1]; expect(await blob.text()).toContain("<script>alert(1)</script>");
    expect(d.objectStore.putOriginal).toHaveBeenCalledWith("snapshot.md", expect.any(Blob), { originalName: "Article.md", mimeType: "text/markdown; charset=utf-8" });
    expect(d.ingestionQueue.send).toHaveBeenCalledWith({ jobId: expect.any(String), documentId: body.documentId, operation: "ingest" });
    expect(JSON.stringify(d.ingestionQueue.send.mock.calls)).not.toContain("Safe");
  });

  test("provider failure creates no document or snapshot", async () => {
    const d = setup(new KnowledgeUrlError("source_disallowed")); const response = await d.request();
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: "source_disallowed", message: "Source disallowed" } });
    expect(d.repository.claimUpload).toHaveBeenCalledOnce(); expect(d.repository.failUpload).toHaveBeenCalledWith(expect.any(String), expect.any(String), "fetch_failed", expect.any(String), "token"); expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
  });

  test.each(["busy", "duplicate"])("does not call provider for %s replay", async (disposition) => {
    const d = setup(); d.repository.claimUpload.mockResolvedValueOnce({ disposition } as never); const response = await d.request();
    expect(response.status).toBe(202); expect(d.safeUrlFetcher.fetchStaticArticle).not.toHaveBeenCalled();
  });

  test("resumes stable queue without calling provider", async () => {
    const d = setup(); d.repository.claimUpload.mockResolvedValueOnce({ disposition: "resume_queue" } as never); const response = await d.request();
    expect(response.status).toBe(202); expect(d.safeUrlFetcher.fetchStaticArticle).not.toHaveBeenCalled(); expect(d.ingestionQueue.send).toHaveBeenCalledOnce();
  });

  test("does not write R2 after claim update fence is lost", async () => {
    const d = setup(); d.repository.updateUploadClaim.mockResolvedValueOnce(false); expect((await d.request()).status).toBe(202); expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
  });

  test("sequential completed replay does not pay provider cost or observe provider outage", async () => {
    const d = setup(); expect((await d.request()).status).toBe(202);
    d.repository.claimUpload.mockResolvedValueOnce({ disposition: "duplicate" } as never);
    d.safeUrlFetcher.fetchStaticArticle.mockRejectedValueOnce(new Error("provider down"));
    expect((await d.request()).status).toBe(202); expect(d.safeUrlFetcher.fetchStaticArticle).toHaveBeenCalledTimes(1);
  });

  test("concurrent busy contender does not call provider", async () => {
    const d = setup(); d.repository.claimUpload.mockResolvedValueOnce({ disposition: "winner", token: "token", r2Key: "snapshot.md", previousR2Key: null }).mockResolvedValueOnce({ disposition: "busy" } as never);
    const responses = await Promise.all([d.request(), d.request()]); expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(d.safeUrlFetcher.fetchStaticArticle).toHaveBeenCalledOnce();
  });

  test.each([["text/plain", "{}"], ["application/json", []], ["application/json", {}], ["application/json", {url:"https://example.com",extra:true}], ["application/json", {url:4}]])("rejects invalid exact JSON", async (contentType, body) => {
    const d = setup(); const response = await d.request(body, contentType as string); expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Invalid request" } }); expect(d.safeUrlFetcher.fetchStaticArticle).not.toHaveBeenCalled();
  });
});
