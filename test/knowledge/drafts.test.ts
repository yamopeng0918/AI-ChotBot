import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";
import draftsMigration from "../../migrations/0007_knowledge_drafts.sql?raw";
import { KnowledgeDraftRepository } from "../../src/knowledge/drafts";

describe("KnowledgeDraftRepository", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let repository: KnowledgeDraftRepository;
  const source = { title: "World Athletics", url: "https://worldathletics.org/guide", retrievedAt: "2026-08-08T00:00:00.000Z" };
  const input = {
    id: "draft-1", topic: "Running guide", markdown: "# Running guide", sources: [source], dedupeKey: "dedupe-1",
    createdAt: "2026-08-08T00:00:00.000Z", expiresAt: "2026-11-06T00:00:00.000Z",
  };

  beforeEach(async () => {
    miniflare = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB"] });
    db = await miniflare.getD1Database("DB");
    await migrate(knowledgeMigration);
    await migrate(draftsMigration);
    repository = new KnowledgeDraftRepository(db);
  });

  afterEach(async () => miniflare.dispose());

  test("creates a pending draft and refreshes a matching pending row without changing its identity", async () => {
    expect(await repository.createOrRefresh(input)).toMatchObject({ id: "draft-1", status: "pending" });
    expect(await repository.createOrRefresh({ ...input, id: "draft-2", createdAt: "2026-08-09T00:00:00.000Z" })).toMatchObject({
      id: "draft-1", createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(await repository.list("pending", 20)).toHaveLength(1);
  });

  test("rejects empty source input before creating a draft", async () => {
    await expect(repository.createOrRefresh({ ...input, sources: [] })).rejects.toThrow("sources must not be empty");
  });

  test("uses deterministic transition results and preserves terminal rows", async () => {
    await repository.createOrRefresh(input);
    expect(await repository.reject("draft-1", "2026-08-10T00:00:00.000Z")).toBe("rejected");
    expect(await repository.reject("draft-1", "2026-08-11T00:00:00.000Z")).toBe("rejected");
    expect(await repository.approve("draft-1", "doc-1", "2026-08-10T00:00:00.000Z")).toBe("conflict");
    expect(await repository.get("draft-1")).toMatchObject({ status: "rejected", expiresAt: "2026-09-09T00:00:00.000Z" });
    expect(await repository.approve("missing", "doc-1", "2026-08-10T00:00:00.000Z")).toBe("not_found");
  });

  test("makes approval idempotent only for the same document", async () => {
    await repository.createOrRefresh(input);
    expect(await repository.approve("draft-1", "doc-1", "2026-08-10T00:00:00.000Z")).toBe("approved");
    expect(await repository.approve("draft-1", "doc-1", "2026-08-11T00:00:00.000Z")).toBe("approved");
    expect(await repository.approve("draft-1", "doc-2", "2026-08-11T00:00:00.000Z")).toBe("conflict");
    expect(await repository.reject("draft-1", "2026-08-11T00:00:00.000Z")).toBe("conflict");
  });

  test("atomically reserves pending publication against reject, refresh, and expiry", async () => {
    await repository.createOrRefresh({ ...input, expiresAt: "2026-08-09T00:00:00.000Z" });
    expect(await repository.reserveApproval("draft-1", "doc-1", "2026-08-08T01:00:00.000Z")).toBe("reserved");
    expect(await repository.reserveApproval("draft-1", "doc-1", "2026-08-08T02:00:00.000Z")).toBe("reserved");
    expect(await repository.reserveApproval("draft-1", "doc-2", "2026-08-08T02:00:00.000Z")).toBe("conflict");
    expect(await repository.reject("draft-1", "2026-08-08T03:00:00.000Z")).toBe("conflict");

    await repository.createOrRefresh({ ...input, id: "replacement", markdown: "# changed", createdAt: "2026-08-09T00:00:00.000Z" });
    await repository.purgeExpired("2026-08-10T00:00:00.000Z");
    expect(await repository.get("draft-1")).toMatchObject({
      status: "pending", documentId: "doc-1", markdown: input.markdown,
      updatedAt: "2026-08-08T01:00:00.000Z",
    });
  });

  test("releases only the matching reservation so a failed publication can retry", async () => {
    await repository.createOrRefresh(input);
    await repository.reserveApproval("draft-1", "doc-1", "2026-08-08T01:00:00.000Z");
    expect(await repository.releaseApproval("draft-1", "doc-2", "2026-08-08T02:00:00.000Z")).toBe(false);
    expect(await repository.releaseApproval("draft-1", "doc-1", "2026-08-08T02:00:00.000Z")).toBe(true);
    expect(await repository.get("draft-1")).toMatchObject({ status: "pending", documentId: null });
    expect(await repository.reserveApproval("draft-1", "doc-1", "2026-08-08T03:00:00.000Z")).toBe("reserved");
  });

  test("clamps list limits and strictly rejects malformed decoded sources", async () => {
    await db.batch(Array.from({ length: 101 }, (_, index) => db.prepare(`INSERT INTO knowledge_drafts
      (id,status,topic,markdown,sources_json,dedupe_key,created_at,updated_at,expires_at)
      VALUES (?, 'pending', 'topic', 'markdown', ?, ?, ?, ?, '2026-11-06T00:00:00.000Z')`).bind(
      `draft-${index}`, JSON.stringify([source]), `dedupe-${index}`,
      `2026-08-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
      `2026-08-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
    )));
    expect(await repository.list("pending", 999)).toHaveLength(100);
    expect(await repository.list("pending", 0)).toHaveLength(1);
    await db.prepare(`INSERT INTO knowledge_drafts
      (id,status,topic,markdown,sources_json,dedupe_key,created_at,updated_at,expires_at)
      VALUES ('insecure','pending','topic','markdown','[{"title":"insecure","url":"http://example.test/","retrievedAt":"2026-08-08T00:00:00.000Z"}]','insecure','2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z','2026-11-06T00:00:00.000Z')`).run();
    await expect(repository.get("insecure")).rejects.toThrow("invalid knowledge draft row");
  });

  test("rejects pending expiry before pruning rejected rows and orphaned approved provenance", async () => {
    await repository.createOrRefresh({ ...input, id: "expired-pending", dedupeKey: "expired-pending", expiresAt: "2026-08-08T00:00:00.000Z" });
    await repository.createOrRefresh({ ...input, id: "expired-rejected", dedupeKey: "expired-rejected" });
    await repository.reject("expired-rejected", "2026-07-01T00:00:00.000Z");
    await repository.createOrRefresh({ ...input, id: "approved-orphan", dedupeKey: "approved-orphan" });
    await repository.approve("approved-orphan", "missing-document", "2026-08-01T00:00:00.000Z");
    await repository.createOrRefresh({ ...input, id: "approved-live", dedupeKey: "approved-live" });
    await db.prepare(`INSERT INTO knowledge_documents (id,source_type,display_name,r2_key,status,created_at,updated_at)
      VALUES ('live-document','file','Live','live.md','pending','2026-08-08T00:00:00.000Z','2026-08-08T00:00:00.000Z')`).run();
    await repository.approve("approved-live", "live-document", "2026-08-01T00:00:00.000Z");

    await repository.purgeExpired("2026-08-08T00:00:00.000Z");

    expect(await repository.get("expired-pending")).toMatchObject({ status: "rejected", expiresAt: "2026-09-07T00:00:00.000Z" });
    expect(await repository.get("expired-rejected")).toBeNull();
    expect(await repository.get("approved-orphan")).toBeNull();
    expect(await repository.get("approved-live")).toMatchObject({ status: "approved", documentId: "live-document" });
  });

  async function migrate(sql: string): Promise<void> {
    await db.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
  }
});
