import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { KnowledgeRepository } from "../../src/knowledge/repository";

describe("knowledge admin metadata API", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    db = await miniflare.getD1Database("DB");
    await applyMigration(db, knowledgeMigration);
    env = { DB: db, ADMIN_API_TOKEN: "admin-secret" } as Env;
  });

  afterEach(async () => miniflare.dispose());

  test("lists authenticated documents newest first with exact statuses", async () => {
    await insertDocument(db, { id: "ready-doc", status: "ready", createdAt: "2026-07-19T00:00:00.000Z" });
    await insertDocument(db, { id: "pending-doc", status: "pending", createdAt: "2026-07-20T00:00:00.000Z" });

    const response = await request("/admin/knowledge/documents");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [
      expect.objectContaining({ id: "pending-doc", status: "pending", sourceType: "file" }),
      expect.objectContaining({ id: "ready-doc", status: "ready", sourceType: "file" }),
    ] });
  });

  test("returns an authenticated document detail with all metadata", async () => {
    await insertDocument(db, { id: "failed-doc", status: "failed", createdAt: "2026-07-20T00:00:00.000Z" });

    const response = await request("/admin/knowledge/documents/failed-doc");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: {
      id: "failed-doc", sourceType: "file", displayName: "failed-doc.pdf", sourceUrl: null,
      r2Key: "sources/failed-doc", activeVersion: null, contentHash: null, pageCount: null,
      errorCode: null, status: "failed", createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    } });
  });

  test("returns a stable not-found error without provider details", async () => {
    const response = await request("/admin/knowledge/documents/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: {
      code: "document_not_found", message: "Document not found",
    } });
  });

  test.each([undefined, "Basic admin-secret", "Bearer wrong"])(
    "returns the same unauthorized response and never queries the repository for %s",
    async (authorization) => {
      const repository = { listDocuments: vi.fn(), getDocument: vi.fn() };
      const worker = createWorker({ knowledge: repository as never });
      const headers = authorization ? { authorization } : undefined;

      const response = await worker.fetch(
        new Request("https://worker.test/admin/knowledge/documents", { headers }), env, {} as ExecutionContext,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
      expect(repository.listDocuments).not.toHaveBeenCalled();
      expect(repository.getDocument).not.toHaveBeenCalled();
    },
  );

  test("does not expose repository error or stack payload", async () => {
    const repository = {
      listDocuments: vi.fn().mockRejectedValue(new Error("D1 provider secret detail")),
      getDocument: vi.fn(),
    };
    const worker = createWorker({ knowledge: repository as never });
    const response = await worker.fetch(new Request("https://worker.test/admin/knowledge/documents", {
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
  });

  test("creates pending document and ingestion job metadata", async () => {
    const repository = new KnowledgeRepository(db);
    const createdAt = "2026-07-20T01:02:03.000Z";

    const document = await repository.createPendingDocument({
      id: "new-doc", sourceType: "url", displayName: "Article",
      sourceUrl: "https://example.com/article", r2Key: null, contentHash: "hash", createdAt,
    });
    const job = await repository.createJob({
      id: "new-job", documentId: document.id, operation: "ingest", createdAt,
    });

    expect(document).toEqual(expect.objectContaining({ id: "new-doc", status: "pending", createdAt, updatedAt: createdAt }));
    expect(job).toEqual({
      id: "new-job", documentId: "new-doc", operation: "ingest", status: "pending",
      attemptCount: 0, leaseToken: null, leaseUntil: null, errorCode: null, createdAt, updatedAt: createdAt,
    });
  });

  test.each([
    ["POST", "/admin/knowledge/files"],
    ["POST", "/admin/knowledge/urls"],
    ["POST", "/admin/knowledge/documents/doc/reindex"],
    ["DELETE", "/admin/knowledge/documents/doc"],
  ])("does not register %s %s early", async (method, path) => {
    const response = await request(path, method);
    expect(response.status).toBe(404);
  });

  test.each([
    ["POST", "/admin/knowledge/files"],
    ["POST", "/admin/knowledge/urls"],
    ["POST", "/admin/knowledge/documents/doc/reindex"],
    ["DELETE", "/admin/knowledge/documents/doc"],
  ])("leaves unregistered %s %s as 404 without authorization", async (method, path) => {
    const worker = createWorker();
    const response = await worker.fetch(
      new Request(`https://worker.test${path}`, { method }), env, {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });

  async function request(path: string, method = "GET"): Promise<Response> {
    const worker = createWorker();
    return worker.fetch(new Request(`https://worker.test${path}`, {
      method, headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);
  }
});

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  await db.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
}

async function insertDocument(
  db: D1Database,
  input: { id: string; status: "pending" | "ready" | "failed"; createdAt: string },
): Promise<void> {
  await db.prepare(`INSERT INTO knowledge_documents
    (id, source_type, display_name, r2_key, status, created_at, updated_at)
    VALUES (?, 'file', ?, ?, ?, ?, ?)`)
    .bind(input.id, `${input.id}.pdf`, `sources/${input.id}`, input.status, input.createdAt, input.createdAt).run();
}

describe("KnowledgeRepository mutations", () => {
  test("uses bound values when marking a document for deletion", async () => {
    const statement = { bind: vi.fn(), run: vi.fn() };
    statement.bind.mockReturnValue(statement);
    statement.run.mockResolvedValue({ meta: { changes: 1 } });
    const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

    await new KnowledgeRepository(db).markDeleting("doc' OR 1=1 --");

    expect(statement.bind).toHaveBeenCalledWith("doc' OR 1=1 --");
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining("doc' OR 1=1 --"));
  });
});
