import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import questionsMigration from "../../migrations/0001_questions.sql?raw";
import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";

describe("knowledge migration", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    db = await miniflare.getD1Database("DB");
    await applyMigration(questionsMigration);
    await applyMigration(knowledgeMigration);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  test("creates all knowledge tables", async () => {
    const result = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge_%' OR type = 'table' AND name = 'ingestion_jobs' ORDER BY name")
      .all<{ name: string }>();

    expect(result.results.map(({ name }) => name)).toEqual([
      "ingestion_jobs",
      "knowledge_chunks",
      "knowledge_documents",
    ]);
  });

  test("rejects invalid document statuses", async () => {
    await expect(
      db.prepare(`INSERT INTO knowledge_documents
        (id, source_type, display_name, r2_key, status, created_at, updated_at)
        VALUES ('doc', 'file', 'Document', 'doc.pdf', 'invalid', 'now', 'now')`).run(),
    ).rejects.toThrow();
  });

  test("rejects invalid ingestion operations", async () => {
    await insertDocument();

    await expect(
      db.prepare(`INSERT INTO ingestion_jobs
        (id, document_id, operation, status, created_at, updated_at)
        VALUES ('job', 'doc', 'invalid', 'pending', 'now', 'now')`).run(),
    ).rejects.toThrow();
  });

  test("enforces unique document version vector IDs", async () => {
    await insertDocument();
    const insert = db.prepare(`INSERT INTO knowledge_chunks
      (id, document_id, index_version, text, vector_id, content_hash, created_at)
      VALUES (?, 'doc', 1, 'text', 'vector', 'hash', 'now')`);
    await insert.bind("chunk-1").run();

    await expect(insert.bind("chunk-2").run()).rejects.toThrow();
  });

  test("adds indexes for supported access paths", async () => {
    const result = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
      .all<{ name: string }>();
    const names = result.results.map(({ name }) => name);

    expect(names).toEqual(expect.arrayContaining([
      "knowledge_documents_status_idx",
      "knowledge_documents_active_version_idx",
      "knowledge_documents_content_hash_idx",
      "knowledge_chunks_document_id_idx",
      "ingestion_jobs_status_lease_until_idx",
      "ingestion_jobs_document_id_idx",
    ]));
  });

  async function insertDocument(): Promise<void> {
    await db.prepare(`INSERT INTO knowledge_documents
      (id, source_type, display_name, r2_key, status, created_at, updated_at)
      VALUES ('doc', 'file', 'Document', 'doc.pdf', 'pending', 'now', 'now')`).run();
  }

  async function applyMigration(sql: string): Promise<void> {
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement));
    await db.batch(statements);
  }
});
