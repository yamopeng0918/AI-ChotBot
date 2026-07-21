import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { KnowledgeUrlError } from "../../src/knowledge/url-safety";
import { KnowledgeRepository } from "../../src/knowledge/repository";
import { Miniflare } from "miniflare";
import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";
import claimMigration from "../../migrations/0003_upload_claim_fencing.sql?raw";
import urlSnapshotMigration from "../../migrations/0004_url_snapshots.sql?raw";

function setup(fetchError?: KnowledgeUrlError) {
  const order: string[] = [];
  const repository = {
    listDocuments: vi.fn(), getDocument: vi.fn(),
    claimUpload: vi.fn(async () => { order.push("claim"); return { disposition: "winner", token: "token", r2Key: "snapshot.md", previousR2Key: null }; }),
    updateUploadClaim: vi.fn(async () => { order.push("update"); return true; }),
    completeUpload: vi.fn(async () => { order.push("complete"); return true; }), failUpload: vi.fn(async () => { order.push("fail"); }), abandonUploadClaim: vi.fn(async () => { order.push("abandon"); return true; }), clearUploadClaim: vi.fn(),
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
    expect(d.repository.claimUpload).toHaveBeenCalledOnce(); expect(d.repository.abandonUploadClaim).toHaveBeenCalledWith(expect.any(String), "token"); expect(d.repository.failUpload).not.toHaveBeenCalled(); expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
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
    const d = setup(); d.repository.updateUploadClaim.mockResolvedValueOnce(false); expect((await d.request()).status).toBe(202); expect(d.objectStore.putOriginal).not.toHaveBeenCalled(); expect(d.repository.abandonUploadClaim).not.toHaveBeenCalled();
  });

  test("abandons same-token claim when metadata update throws", async () => {
    const d = setup(); d.repository.updateUploadClaim.mockRejectedValueOnce(new Error("db")); const response = await d.request();
    expect(response.status).toBe(500); expect(d.repository.abandonUploadClaim).toHaveBeenCalledWith(expect.any(String), "token"); expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
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

test("real D1 removes failed provider claim and permits a clean same-key retry", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch(){return new Response('ok')} }", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB"); await applyMigrations(db); const repository = new KnowledgeRepository(db, () => "token");
    const provider = { fetchStaticArticle: vi.fn().mockRejectedValueOnce(new KnowledgeUrlError("source_unavailable")).mockResolvedValueOnce({ finalUrl: "https://example.com/", title: "Article", html: "content", fetchedAt: "now" }) };
    const objects = new Map<string,string>(); const store = { putOriginal: vi.fn(async (key:string,body:Blob) => objects.set(key,await body.text())), getOriginal:vi.fn(), deleteOriginal:vi.fn(async(key:string)=>objects.delete(key)) }; const queue={send:vi.fn()};
    const worker=createWorker({knowledge:repository,safeUrlFetcher:provider,objectStore:store as never,ingestionQueue:queue as never,now:()=>new Date("2026-07-21T00:00:00Z")});
    const request=()=>worker.fetch(new Request("https://worker.test/admin/knowledge/urls",{method:"POST",headers:{authorization:"Bearer admin","Idempotency-Key":"retry","content-type":"application/json"},body:JSON.stringify({url:"https://example.com/"})}),{DB:db,ADMIN_API_TOKEN:"admin"} as Env,{} as ExecutionContext);
    expect((await request()).status).toBe(503); expect(await counts(db)).toEqual({documents:0,jobs:0});
    expect((await request()).status).toBe(202); expect(await counts(db)).toEqual({documents:1,jobs:1}); expect(objects.size).toBe(1); expect(queue.send).toHaveBeenCalledOnce(); expect(provider.fetchStaticArticle).toHaveBeenCalledTimes(2);
  } finally { await mf.dispose(); }
});

test("real D1 stale abandon cannot delete a newer generation or finalized document", async () => {
  const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["DB"]});
  try { const db=await mf.getD1Database("DB");await applyMigrations(db);const tokens=["old","new"];const repository=new KnowledgeRepository(db,()=>tokens.shift()!);const input={id:"doc",sourceType:"url" as const,displayName:"example.com",sourceUrl:"https://example.com/",r2Key:null,contentHash:null,createdAt:"2026-07-21T00:00:00.000Z"};
    const old=await repository.claimUpload(input,"job","2026-07-21T00:00:00.000Z",".md");if(old.disposition!=="winner")throw new Error();
    const newer=await repository.claimUpload(input,"job","2026-07-21T00:05:00.000Z",".md");if(newer.disposition!=="winner")throw new Error();
    await expect(repository.abandonUploadClaim("doc",old.token)).resolves.toBe(false);expect(await repository.getDocument("doc")).toEqual(expect.objectContaining({status:"processing"}));
    await repository.completeUpload("doc",{id:"job",documentId:"doc",operation:"ingest",createdAt:input.createdAt},newer.token,input.createdAt);
    await expect(repository.abandonUploadClaim("doc",newer.token)).resolves.toBe(false);expect(await counts(db)).toEqual({documents:1,jobs:1});
  } finally {await mf.dispose();}
});

async function applyMigrations(db:D1Database){for(const sql of [knowledgeMigration,claimMigration,urlSnapshotMigration])await db.batch(sql.split(";").map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
async function counts(db:D1Database){return {documents:(await db.prepare("SELECT count(*) count FROM knowledge_documents").first<{count:number}>())!.count,jobs:(await db.prepare("SELECT count(*) count FROM ingestion_jobs").first<{count:number}>())!.count};}
