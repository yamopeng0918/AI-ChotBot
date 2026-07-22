import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";
import claimMigration from "../../migrations/0003_upload_claim_fencing.sql?raw";
import lifecycleMigration from "../../migrations/0005_ingestion_lifecycle.sql?raw";
import segmentMigration from "../../migrations/0006_knowledge_chunk_segments.sql?raw";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { processIngestionJob } from "../../src/knowledge/ingestion";
import { KnowledgeRepository } from "../../src/knowledge/repository";
import type { IngestionJobMessage } from "../../src/knowledge/types";

describe("knowledge lifecycle routes", () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    db = await mf.getD1Database("DB");
    await migrate(db, knowledgeMigration);
    await migrate(db, claimMigration);
    await migrate(db, lifecycleMigration);
    await migrate(db, segmentMigration);
    env = { DB: db, ADMIN_API_TOKEN: "admin-secret" } as Env;
  });

  afterEach(async () => mf.dispose());

  test("reindex keeps the prior active version searchable until publish", async () => {
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc.pdf",
      status: "ready",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    await seedChunk(db, { documentId: "doc", indexVersion: 1, vectorId: "a".repeat(64) });
    const queue = { send: vi.fn(async () => undefined) };
    const worker = createWorker({ knowledge: repository as never, ingestionQueue: queue as never });

    const response = await worker.fetch(new Request("https://worker.test/admin/knowledge/documents/doc/reindex", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);

    expect(response.status).toBe(202);
    const body = await response.json() as { jobId: string; status: string };
    expect(body).toEqual({ jobId: expect.any(String), status: "pending" });
    expect(queue.send).toHaveBeenCalledWith({ jobId: body.jobId, documentId: "doc", kind: "reindex" });
    expect(await repository.getDocument("doc")).toEqual(expect.objectContaining({ activeVersion: 1, status: "ready" }));
    expect(await repository.authorizeVectorIds(["a".repeat(64)])).toHaveLength(1);
  });

  test("concurrent reindex requests return 409", async () => {
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc.pdf",
      status: "ready",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const queue = { send: vi.fn(async () => undefined) };
    const worker = createWorker({ knowledge: repository as never, ingestionQueue: queue as never });
    const request = () => worker.fetch(new Request("https://worker.test/admin/knowledge/documents/doc/reindex", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);

    expect((await request()).status).toBe(202);
    const second = await request();
    expect(second.status).toBe(409);
  });

  test("delete tombstones immediately, then deletes vectors, chunks, and R2 content", async () => {
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc.pdf",
      status: "ready",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    await seedChunk(db, { documentId: "doc", indexVersion: 1, vectorId: "a".repeat(64) });
    const deleted: string[] = [];
    const vectors = { upsert: vi.fn(), deleteIds: vi.fn(async (ids: string[]) => { deleted.push(...ids); }) };
    const objectStore = { getOriginal: vi.fn(), deleteOriginal: vi.fn(async () => undefined) };
    const queue = { send: vi.fn(async (message: IngestionJobMessage) => deleted.push(message.jobId)) };
    const worker = createWorker({
      knowledge: repository as never,
      ingestionQueue: queue as never,
      ingestion: {
        repository,
        objectStore: objectStore as never,
        converter: { convert: vi.fn() },
        embeddings: { embed: vi.fn() },
        vectors: vectors as never,
        now: () => new Date("2026-07-22T00:00:00.000Z"),
      },
    });

    const response = await worker.fetch(new Request("https://worker.test/admin/knowledge/documents/doc", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);

    expect(response.status).toBe(202);
    const body = await response.json() as { jobId: string; status: string };
    expect(body).toEqual({ jobId: expect.any(String), status: "pending" });
    expect(await repository.getDocument("doc")).toEqual(expect.objectContaining({ status: "deleting", activeVersion: 1 }));
    expect(await repository.authorizeVectorIds(["a".repeat(64)])).toHaveLength(0);

    await worker.queue({ messages: [{ body: { jobId: body.jobId, documentId: "doc", kind: "delete" }, ack: vi.fn(), retry: vi.fn() }] } as never, env, {} as ExecutionContext);

    expect(vectors.deleteIds).toHaveBeenCalledWith(["a".repeat(64)]);
    expect(objectStore.deleteOriginal).toHaveBeenCalledWith("doc.pdf");
    expect(await repository.getJob(body.jobId)).toEqual(expect.objectContaining({ status: "completed" }));
    expect(await db.prepare("SELECT COUNT(*) count FROM knowledge_chunks WHERE document_id='doc'").first()).toEqual({ count: 0 });
    expect(await repository.getDocument("doc")).toEqual(expect.objectContaining({
      status: "deleting",
      activeVersion: null,
      r2Key: "doc.pdf",
      contentHash: null,
      pageCount: null,
    }));
  });

  test("repeated delete returns the same tombstone job id", async () => {
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc.pdf",
      status: "ready",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const queue = { send: vi.fn(async () => undefined) };
    const worker = createWorker({ knowledge: repository as never, ingestionQueue: queue as never });

    const first = await worker.fetch(new Request("https://worker.test/admin/knowledge/documents/doc", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);
    const firstBody = await first.json() as { jobId: string; status: string };

    const second = await worker.fetch(new Request("https://worker.test/admin/knowledge/documents/doc", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);
    const secondBody = await second.json() as { jobId: string; status: string };

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  test("a stale delete job does not remove a replacement version", async () => {
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc.pdf",
      status: "ready",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    await seedChunk(db, { documentId: "doc", indexVersion: 1, vectorId: "a".repeat(64) });
    const vectors = { upsert: vi.fn(), deleteIds: vi.fn() };
    const objectStore = { getOriginal: vi.fn(), deleteOriginal: vi.fn() };
    const queue = { send: vi.fn(async () => undefined) };
    const worker = createWorker({
      knowledge: repository as never,
      ingestionQueue: queue as never,
      ingestion: {
        repository,
        objectStore: objectStore as never,
        converter: { convert: vi.fn() },
        embeddings: { embed: vi.fn() },
        vectors: vectors as never,
        now: () => new Date("2026-07-22T00:00:00.000Z"),
      },
    });

    const response = await worker.fetch(new Request("https://worker.test/admin/knowledge/documents/doc", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-secret" },
    }), env, {} as ExecutionContext);
    const body = await response.json() as { jobId: string };

    await seedReadyDocument(db, {
      id: "doc",
      activeVersion: 2,
      nextVersion: 3,
      r2Key: "replacement.pdf",
      status: "ready",
      updatedAt: "2026-07-22T00:01:00.000Z",
    });
    await seedChunk(db, { documentId: "doc", indexVersion: 2, vectorId: "b".repeat(64) });

    await worker.queue({ messages: [{ body: { jobId: body.jobId, documentId: "doc", kind: "delete" }, ack: vi.fn(), retry: vi.fn() }] } as never, env, {} as ExecutionContext);

    expect(vectors.deleteIds).not.toHaveBeenCalled();
    expect(objectStore.deleteOriginal).not.toHaveBeenCalled();
    expect(await repository.getDocument("doc")).toEqual(expect.objectContaining({ activeVersion: 2, r2Key: "replacement.pdf", status: "ready" }));
  });
});

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
}

async function seedReadyDocument(
  db: D1Database,
  input: {
    id: string;
    activeVersion: number;
    nextVersion: number;
    r2Key: string;
    status: "ready" | "deleting";
    updatedAt: string;
  },
): Promise<void> {
  await db.prepare(`INSERT OR REPLACE INTO knowledge_documents
    (id, source_type, display_name, source_url, r2_key, active_version, next_version, status, created_at, updated_at)
    VALUES (?, 'file', ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .bind(input.id, `${input.id}.pdf`, input.r2Key, input.activeVersion, input.nextVersion, input.status, input.updatedAt, input.updatedAt)
    .run();
}

async function seedChunk(
  db: D1Database,
  input: { documentId: string; indexVersion: number; vectorId: string },
): Promise<void> {
  await db.prepare(`INSERT OR REPLACE INTO knowledge_chunks
    (id, document_id, index_version, text, page_number, section_path, paragraph_index, segment_index, vector_id, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.documentId, input.indexVersion, "chunk", 1, null, 0, 0, input.vectorId, "hash", "2026-07-22T00:00:00.000Z")
    .run();
}
