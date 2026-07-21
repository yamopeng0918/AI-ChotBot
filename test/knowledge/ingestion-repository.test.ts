import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import questions from "../../migrations/0001_questions.sql?raw";
import knowledge from "../../migrations/0002_knowledge.sql?raw";
import claims from "../../migrations/0003_upload_claim_fencing.sql?raw";
import snapshots from "../../migrations/0004_url_snapshots.sql?raw";
import lifecycle from "../../migrations/0005_ingestion_lifecycle.sql?raw";
import { KnowledgeRepository, StaleIngestionClaimError } from "../../src/knowledge/repository";

describe("fenced ingestion repository", () => {
  let mf: Miniflare; let db: D1Database; let tokens: string[]; let repository: KnowledgeRepository;
  const t0 = "2026-07-21T00:00:00.000Z";

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DB"] });
    db = await mf.getD1Database("DB");
    for (const sql of [questions, knowledge, claims, snapshots, lifecycle]) await migrate(db, sql);
    tokens = ["token-1", "token-2", "token-3", "token-4", "token-5"];
    repository = new KnowledgeRepository(db, () => tokens.shift()!);
    await repository.createPendingDocument({ id: "doc", sourceType: "file", displayName: "Doc", sourceUrl: null, r2Key: "doc.pdf", createdAt: t0 });
    await repository.createJob({ id: "job", documentId: "doc", operation: "ingest", createdAt: t0 });
  });
  afterEach(() => mf.dispose());

  test("first claim acquires an exact lease and increments attempts", async () => {
    expect(await repository.claimJob("job", 300, t0)).toEqual({ disposition: "acquired", leaseToken: "token-1", leaseUntil: "2026-07-21T00:05:00.000Z", attemptCount: 1 });
  });
  test("busy claim rounds remaining delay up with a minimum of one", async () => {
    await repository.claimJob("job", 300, t0);
    expect(await repository.claimJob("job", 300, "2026-07-21T00:04:59.500Z")).toEqual({ disposition: "busy", delaySeconds: 1 });
  });
  test("an expired lease is reclaimed and the old owner is fenced", async () => {
    await repository.claimJob("job", 300, t0);
    const claim = await repository.claimJob("job", 300, "2026-07-21T00:05:00.000Z");
    expect(claim).toEqual({ disposition: "acquired", leaseToken: "token-2", leaseUntil: "2026-07-21T00:10:00.000Z", attemptCount: 2 });
    await expect(repository.renewJob("job", "token-1", "2026-07-21T00:05:01.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
  });
  test("every mutation rejects stale owners and changes nothing", async () => {
    await repository.claimJob("job", 300, t0);
    const before = await row("job");
    await expect(repository.failJob("job", "bad", "permanent", "wrong", "2026-07-21T00:01:00.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
    await expect(repository.beginVersion("job", "wrong", "2026-07-21T00:01:00.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
    await expect(repository.publishVersion("job", "wrong", "2026-07-21T00:01:00.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
    await expect(repository.completeJob("job", "wrong", "2026-07-21T00:01:00.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
    expect(await row("job")).toEqual(before);
  });
  test("lease expiry during a mutation fences the former owner", async () => {
    await repository.claimJob("job", 300, t0);
    await expect(repository.beginVersion("job", "token-1", "2026-07-21T00:05:00.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
    expect((await row("job")).index_version).toBeNull();
  });
  test("the fifth delivery exhausts attempts atomically", async () => {
    for (let n = 0; n < 4; n++) {
      const at = new Date(Date.parse(t0) + n * 300_000).toISOString();
      expect((await repository.claimJob("job", 300, at)).disposition).toBe("acquired");
    }
    expect(await repository.claimJob("job", 300, "2026-07-21T00:20:00.000Z")).toEqual({ disposition: "failed", ack: true, failureKind: "permanent", errorCode: "retry_exhausted" });
    expect(await row("job")).toEqual(expect.objectContaining({ status: "failed", attempt_count: 4, failure_kind: "permanent", error_code: "retry_exhausted", lease_token: null }));
  });
  test("beginVersion allocates once and leaves an old active version live until publish", async () => {
    await db.prepare("UPDATE knowledge_documents SET active_version=3,status='ready',next_version=4 WHERE id='doc'").run();
    await repository.claimJob("job", 300, t0);
    expect(await repository.beginVersion("job", "token-1", "2026-07-21T00:01:00.000Z")).toBe(4);
    expect(await repository.beginVersion("job", "token-1", "2026-07-21T00:02:00.000Z")).toBe(4);
    expect(await db.prepare("SELECT active_version,next_version,status FROM knowledge_documents WHERE id='doc'").first()).toEqual({ active_version: 3, next_version: 5, status: "ready" });
    await repository.publishVersion("job", "token-1", "2026-07-21T00:03:00.000Z");
    expect(await db.prepare("SELECT active_version,status FROM knowledge_documents WHERE id='doc'").first()).toEqual({ active_version: 4, status: "ready" });
    expect((await row("job")).status).toBe("processing");
  });
  test("concurrent jobs allocate distinct versions", async () => {
    await repository.createJob({ id: "job-2", documentId: "doc", operation: "reindex", createdAt: t0 });
    await repository.claimJob("job", 300, t0); await repository.claimJob("job-2", 300, t0);
    const versions = await Promise.all([repository.beginVersion("job", "token-1", t0), repository.beginVersion("job-2", "token-2", t0)]);
    expect(versions.sort()).toEqual([1, 2]);
  });
  test("completion and failure preserve immutable metadata and terminal redelivery acks", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    await repository.completeJob("job", "token-1", "2026-07-21T00:01:00.000Z");
    expect(await row("job")).toEqual(expect.objectContaining({ status: "completed", created_at: t0, attempt_count: 1, index_version: 1, error_code: null, failure_kind: null }));
    expect(await repository.claimJob("job", 300, "2026-07-21T00:02:00.000Z")).toEqual({ disposition: "completed", ack: true });
  });
  test("failed jobs are immutable but retry can use a new ID", async () => {
    await repository.claimJob("job", 300, t0); await repository.failJob("job", "upstream", "retryable", "token-1", "2026-07-21T00:01:00.000Z");
    expect(await repository.claimJob("job", 300, "2026-07-21T00:02:00.000Z")).toEqual({ disposition: "failed", ack: true, failureKind: "retryable", errorCode: "upstream" });
    await repository.createJob({ id: "job-retry", documentId: "doc", operation: "ingest", createdAt: "2026-07-21T00:02:00.000Z" });
    expect((await repository.claimJob("job-retry", 300, "2026-07-21T00:02:00.000Z")).disposition).toBe("acquired");
  });
  test("missing jobs are typed permanent terminal results", async () => {
    expect(await repository.claimJob("missing", 300, t0)).toEqual({ disposition: "failed", ack: true, failureKind: "permanent", errorCode: "not_found" });
  });

  async function row(id: string): Promise<Record<string, unknown>> { return (await db.prepare("SELECT * FROM ingestion_jobs WHERE id=?").bind(id).first())!; }
});

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.batch(sql.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
}
