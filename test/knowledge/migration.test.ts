import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import questionsMigration from "../../migrations/0001_questions.sql?raw";
import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";
import claimMigration from "../../migrations/0003_upload_claim_fencing.sql?raw";
import urlSnapshotMigration from "../../migrations/0004_url_snapshots.sql?raw";
import lifecycleMigration from "../../migrations/0005_ingestion_lifecycle.sql?raw";
import segmentMigration from "../../migrations/0006_knowledge_chunk_segments.sql?raw";

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
    await applyMigration(claimMigration);
    await db.prepare(`INSERT INTO knowledge_documents (id,source_type,display_name,source_url,r2_key,active_version,content_hash,status,created_at,updated_at,upload_claim_token,upload_claim_until) VALUES
      ('legacy-file','file','File',NULL,'file.pdf',3,'fh','ready','c1','u1',NULL,NULL),
      ('legacy-url','url','URL','https://example.com/',NULL,NULL,'uh','ready','c2','u2',NULL,NULL)`).run();
    await db.prepare(`INSERT INTO knowledge_chunks (id,document_id,index_version,text,page_number,section_path,paragraph_index,vector_id,content_hash,created_at) VALUES
      ('file-chunk','legacy-file',1,'file text',1,'s',0,'fv','fch','c1'),
      ('url-chunk','legacy-url',2,'url text',NULL,NULL,NULL,'uv','uch','c2')`).run();
    await db.prepare(`INSERT INTO ingestion_jobs (id,document_id,operation,status,attempt_count,error_code,created_at,updated_at) VALUES
      ('file-job','legacy-file','ingest','completed',2,NULL,'c1','u1'),
      ('url-job','legacy-url','reindex','failed',3,'old_error','c2','u2')`).run();
    await applyMigration(urlSnapshotMigration);
    await applyMigration(lifecycleMigration);
    await applyMigration(segmentMigration);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  test("creates all knowledge tables", async () => {
    const result = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'knowledge_%' OR name LIKE 'ingestion_%') ORDER BY name")
      .all<{ name: string }>();

    expect(result.results.map(({ name }) => name)).toEqual([
      "ingestion_generation_cleanups",
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

  test("preserves schema and permits URL source with a private snapshot", async () => {
    expect((await db.prepare("SELECT * FROM knowledge_documents WHERE id IN ('legacy-file','legacy-url') ORDER BY id").all()).results).toEqual([
      expect.objectContaining({ id: "legacy-file", source_type: "file", display_name: "File", source_url: null, r2_key: "file.pdf", content_hash: "fh", status: "ready", created_at: "c1", updated_at: "u1" }),
      expect.objectContaining({ id: "legacy-url", source_type: "url", display_name: "URL", source_url: "https://example.com/", r2_key: null, content_hash: "uh", status: "ready", created_at: "c2", updated_at: "u2" }),
    ]);
    expect((await db.prepare("SELECT count(*) count FROM knowledge_chunks").first<{count:number}>())!.count).toBe(2);
    expect((await db.prepare("SELECT count(*) count FROM ingestion_jobs").first<{count:number}>())!.count).toBe(2);
    await db.prepare(`INSERT INTO knowledge_documents
      (id, source_type, display_name, source_url, r2_key, status, created_at, updated_at, upload_claim_token)
      VALUES ('url-doc', 'url', 'Article', 'https://example.com/', 'url-doc.md', 'processing', 'now', 'now', 'token')`).run();
    expect(await db.prepare("SELECT upload_claim_token FROM knowledge_documents WHERE id='url-doc'").first()).toEqual({ upload_claim_token: "token" });
    await expect(db.prepare("DELETE FROM knowledge_documents WHERE id='legacy-url'").run()).resolves.toBeTruthy();
    expect((await db.prepare("SELECT count(*) count FROM knowledge_chunks WHERE document_id='legacy-url'").first<{count:number}>())!.count).toBe(0);
    expect((await db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE document_id='legacy-url'").first<{count:number}>())!.count).toBe(0);
  });

  test("upgrades 0001 through 0006 without losing data and initializes lifecycle and segment columns", async () => {
    expect(await db.prepare("SELECT id,next_version FROM knowledge_documents ORDER BY id").all()).toEqual(expect.objectContaining({
      results: [{ id: "legacy-file", next_version: 4 }, { id: "legacy-url", next_version: 1 }],
    }));
    expect(await db.prepare("SELECT id,index_version,failure_kind FROM ingestion_jobs ORDER BY id").all()).toEqual(expect.objectContaining({
      results: [{ id: "file-job", index_version: null, failure_kind: null }, { id: "url-job", index_version: null, failure_kind: null }],
    }));
    expect(await db.prepare("SELECT id,segment_index FROM knowledge_chunks ORDER BY id").all()).toEqual(expect.objectContaining({
      results: [{ id: "file-chunk", segment_index: 0 }, { id: "url-chunk", segment_index: 0 }],
    }));
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
