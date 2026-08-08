import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import draftsMigration from "../migrations/0007_knowledge_drafts.sql?raw";

describe("knowledge draft migration", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    db = await miniflare.getD1Database("DB");
    await migrate(db, draftsMigration);
  });

  afterEach(async () => miniflare.dispose());

  test("enforces draft statuses, source JSON, dedupe keys, and approval provenance", async () => {
    const insert = (id: string, status: string, sourcesJson: string, dedupeKey: string, documentId: string | null, reviewedAt: string | null) => db.prepare(`INSERT INTO knowledge_drafts
      (id,status,topic,markdown,sources_json,dedupe_key,document_id,created_at,updated_at,expires_at,reviewed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, status, "Running guide", "# Running guide", sourcesJson, dedupeKey, documentId,
      "2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-11-06T00:00:00.000Z", reviewedAt,
    ).run();

    const sources = '[{"title":"World Athletics","url":"https://worldathletics.org/guide","retrievedAt":"2026-08-08T00:00:00.000Z"}]';
    await insert("pending", "pending", sources, "dedupe-pending", null, null);
    await expect(insert("bad-status", "unknown", sources, "dedupe-status", null, null)).rejects.toThrow();
    await expect(insert("bad-json", "pending", "not-json", "dedupe-json", null, null)).rejects.toThrow();
    await expect(insert("duplicate", "pending", sources, "dedupe-pending", null, null)).rejects.toThrow();
    await expect(insert("missing-document", "approved", sources, "dedupe-approved", null, "2026-08-08T00:00:00.000Z")).rejects.toThrow();
  });

  test("creates draft access indexes", async () => {
    const result = await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_knowledge_drafts_%' ORDER BY name").all<{ name: string }>();
    expect(result.results.map((row) => row.name)).toEqual([
      "idx_knowledge_drafts_expiry",
      "idx_knowledge_drafts_status_updated",
    ]);
  });
});

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
}
