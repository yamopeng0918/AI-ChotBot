import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { KnowledgeRepository } from "../../src/knowledge/repository";
import { Miniflare } from "miniflare";
import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";

function setup(options: { queueFails?: boolean; duplicate?: boolean } = {}) {
  const order: string[] = [];
  const repository = {
    listDocuments: vi.fn(), getDocument: vi.fn(), claimUpload: vi.fn(async () => { order.push("claim"); return { won: !options.duplicate }; }),
    completeUpload: vi.fn(async () => order.push("complete")),
    failUpload: vi.fn(async () => order.push("fail")),
  };
  const objectStore = {
    putOriginal: vi.fn(async () => order.push("r2")), getOriginal: vi.fn(),
    deleteOriginal: vi.fn(async () => order.push("delete")),
  };
  const ingestionQueue = { send: vi.fn(async () => { order.push("queue"); if (options.queueFails) throw new Error("secret"); }) };
  const validateFile = vi.fn(async () => { order.push("validate"); return { kind: "pdf" as const, mimeType: "application/pdf", extension: ".pdf" }; });
  const worker = createWorker({ knowledge: repository as never, objectStore: objectStore as never, ingestionQueue: ingestionQueue as never, validateFile, now: () => new Date("2026-07-20T00:00:00Z") });
  const env = { ADMIN_API_TOKEN: "admin" } as Env;
  const upload = async (key = "request-1", form = validForm()) => worker.fetch(new Request("https://worker.test/admin/knowledge/files", {
    method: "POST", headers: { authorization: "Bearer admin", "Idempotency-Key": key }, body: form,
  }), env, {} as ExecutionContext);
  return { order, repository, objectStore, ingestionQueue, validateFile, upload };
}

describe("POST /admin/knowledge/files", () => {
  test("validates, stores, atomically creates metadata, then enqueues IDs only", async () => {
    const d = setup(); const response = await d.upload();
    expect(response.status).toBe(202);
    const body = await response.json() as { documentId: string; status: string };
    expect(body.status).toBe("pending");
    expect(body.documentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(d.order).toEqual(["validate", "claim", "r2", "complete", "queue"]);
    const key = (d.objectStore.putOriginal.mock.calls as unknown as [string, Blob, object][])[0]![0];
    expect(key).toBe(`${body.documentId}.pdf`); expect(key).not.toContain("original");
    expect(d.ingestionQueue.send).toHaveBeenCalledWith(expect.objectContaining({ documentId: body.documentId, operation: "ingest", jobId: expect.any(String) }));
    expect(JSON.stringify(d.ingestionQueue.send.mock.calls)).not.toMatch(/original|PDF|admin/);
  });

  test("replays duplicate request without side effects", async () => {
    const d = setup({ duplicate: true }); const a = await d.upload("same"); const b = await d.upload("same");
    expect(await a.json()).toEqual(await b.json()); expect(a.status).toBe(202);
    expect(d.validateFile).toHaveBeenCalledTimes(2); expect(d.objectStore.putOriginal).not.toHaveBeenCalled();
    expect(d.repository.completeUpload).not.toHaveBeenCalled(); expect(d.ingestionQueue.send).not.toHaveBeenCalled();
  });

  test("fails metadata, deletes the new object, and hides queue/cleanup errors", async () => {
    const d = setup({ queueFails: true }); d.objectStore.deleteOriginal.mockRejectedValueOnce(new Error("r2 secret"));
    const response = await d.upload(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "queue_unavailable", message: "Queue unavailable" } });
    expect(d.repository.failUpload).toHaveBeenCalledWith(expect.any(String), expect.any(String), "queue_send_failed", "2026-07-20T00:00:00.000Z");
    expect(d.objectStore.deleteOriginal).toHaveBeenCalled();
  });

  test.each([undefined, " ", "x".repeat(129)])("rejects invalid idempotency key %s", async (key) => {
    const d = setup(); const headers: Record<string,string> = { authorization: "Bearer admin" }; if (key !== undefined) headers["Idempotency-Key"] = key;
    const response = await createWorker({ knowledge: d.repository as never }).fetch(new Request("https://worker.test/admin/knowledge/files", { method: "POST", headers, body: validForm() }), { ADMIN_API_TOKEN: "admin" } as Env, {} as ExecutionContext);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: "invalid_idempotency_key", message: "Invalid Idempotency-Key" } });
  });

  test("requires exactly one multipart File", async () => {
    const d = setup(); const form = validForm(); form.append("other", new File(["x"], "x.txt", { type: "text/plain" }));
    const response = await d.upload("one", form); expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "single_file_required", message: "Single file required" } });
  });
});

test("atomically claims a single winner and exposes no job until storage completes in real D1", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    await db.batch(knowledgeMigration.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    const repository = new KnowledgeRepository(db); const createdAt = "2026-07-20T00:00:00.000Z";
    const document = { id: "11111111-1111-4111-8111-111111111111", sourceType: "file" as const, displayName: "a.pdf", sourceUrl: null, r2Key: "key.pdf", createdAt };
    const job = { id: "22222222-2222-4222-8222-222222222222", documentId: document.id, operation: "ingest" as const, createdAt };
    const claims = await Promise.all([repository.claimUpload(document), repository.claimUpload({ ...document, displayName: "loser.png", r2Key: "loser.png", contentHash: "loser" })]);
    expect(claims.filter((claim) => claim.won)).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ingestion_jobs").first<{count:number}>())!.count).toBe(0);
    await repository.completeUpload(document.id, job, createdAt);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ingestion_jobs").first<{count:number}>())!.count).toBe(1);
    expect(await repository.getDocument(document.id)).toEqual(expect.objectContaining({ displayName: "a.pdf", r2Key: "key.pdf", status: "pending" }));
  } finally { await mf.dispose(); }
});

test("concurrent same-key uploads with different content/extensions have one R2 winner matching D1", async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB"); await db.batch(knowledgeMigration.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    const puts: Array<{ key: string; body: string }> = []; const queue = { send: vi.fn(async () => ({ outcome: "ok" })) };
    const store = { putOriginal: vi.fn(async (key: string, body: Blob) => { puts.push({ key, body: await body.text() }); }), getOriginal: vi.fn(), deleteOriginal: vi.fn() };
    const worker = createWorker({ knowledge: new KnowledgeRepository(db), objectStore: store as never, ingestionQueue: queue as never,
      validateFile: async (file) => file.name.endsWith(".png") ? { kind: "png", mimeType: "image/png", extension: ".png" } : { kind: "pdf", mimeType: "application/pdf", extension: ".pdf" },
      now: () => new Date("2026-07-20T00:00:00Z") });
    const request = (name: string, content: string) => { const form = new FormData(); form.append("file", new File([content], name, { type: name.endsWith(".png") ? "image/png" : "application/pdf" })); return worker.fetch(new Request("https://worker.test/admin/knowledge/files", { method: "POST", headers: { authorization: "Bearer admin", "Idempotency-Key": "race" }, body: form }), { DB: db, ADMIN_API_TOKEN: "admin" } as Env, {} as ExecutionContext); };
    const responses = await Promise.all([request("winner.pdf", "PDF-CONTENT"), request("loser.png", "PNG-CONTENT")]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]); expect(puts).toHaveLength(1); expect(queue.send).toHaveBeenCalledTimes(1);
    const id = ((await responses[0]!.json()) as {documentId:string}).documentId; const doc = await new KnowledgeRepository(db).getDocument(id);
    expect(puts[0]!.key).toBe(doc!.r2Key); expect(doc!.displayName).toBe(puts[0]!.body === "PDF-CONTENT" ? "winner.pdf" : "loser.png");
    expect(doc!.contentHash).toBe(await sha256(puts[0]!.body)); expect((await db.prepare("SELECT COUNT(*) count FROM ingestion_jobs").first<{count:number}>())!.count).toBe(1);
  } finally { await mf.dispose(); }
});

function validForm() { const form = new FormData(); form.append("file", new File(["%PDF-1.7"], "ori\u0000ginal.pdf", { type: "application/pdf" })); return form; }
async function sha256(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2,"0")).join(""); }
