import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import questions from "../../migrations/0001_questions.sql?raw";
import knowledge from "../../migrations/0002_knowledge.sql?raw";
import claims from "../../migrations/0003_upload_claim_fencing.sql?raw";
import snapshots from "../../migrations/0004_url_snapshots.sql?raw";
import lifecycle from "../../migrations/0005_ingestion_lifecycle.sql?raw";
import staging from "../../migrations/0006_knowledge_chunk_segments.sql?raw";
import { KnowledgeRepository, StaleIngestionClaimError } from "../../src/knowledge/repository";

describe("fenced ingestion repository", () => {
  let mf: Miniflare; let db: D1Database; let tokens: string[]; let repository: KnowledgeRepository;
  const t0 = "2026-07-21T00:00:00.000Z";

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DB"] });
    db = await mf.getD1Database("DB");
    for (const sql of [questions, knowledge, claims, snapshots, lifecycle, staging]) await migrate(db, sql);
    tokens = ["token-1", "token-2", "token-3", "token-4", "token-5", "token-6", "token-7", "token-8"];
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

  test("publishing cannot roll an active version back and equal-version retry succeeds", async () => {
    await repository.createJob({ id: "job-2", documentId: "doc", operation: "reindex", createdAt: t0 });
    await repository.claimJob("job", 300, t0); await repository.claimJob("job-2", 300, t0);
    expect(await repository.beginVersion("job", "token-1", t0)).toBe(1);
    expect(await repository.beginVersion("job-2", "token-2", t0)).toBe(2);
    await repository.publishVersion("job-2", "token-2", "2026-07-21T00:01:00.000Z");
    await repository.publishVersion("job-2", "token-2", "2026-07-21T00:01:01.000Z");
    await expect(repository.publishVersion("job", "token-1", "2026-07-21T00:01:02.000Z")).rejects.toBeInstanceOf(StaleIngestionClaimError);
    expect(await db.prepare("SELECT active_version FROM knowledge_documents WHERE id='doc'").first()).toEqual({ active_version: 2 });
  });

  test.each([0, -300, 299, 301, NaN, Infinity])("rejects invalid lease seconds %s before token or D1 access", async (leaseSeconds) => {
    let tokenCalls = 0; let dbCalls = 0;
    const guarded = new KnowledgeRepository(new Proxy({} as D1Database, { get() { dbCalls++; throw new Error("db accessed"); } }), () => { tokenCalls++; return "token"; });
    await expect(guarded.claimJob("job", leaseSeconds, t0)).rejects.toBeInstanceOf(RangeError);
    expect({ tokenCalls, dbCalls }).toEqual({ tokenCalls: 0, dbCalls: 0 });
  });

  test("rejects invalid mutation times before touching D1", async () => {
    let dbCalls = 0;
    const guarded = new KnowledgeRepository(new Proxy({} as D1Database, { get() { dbCalls++; throw new Error("db accessed"); } }));
    await expect(guarded.claimJob("job", 300, "invalid")).rejects.toBeInstanceOf(RangeError);
    await expect(guarded.renewJob("job", "token", "invalid")).rejects.toBeInstanceOf(RangeError);
    await expect(guarded.failJob("job", "bad", "permanent", "token", "invalid")).rejects.toBeInstanceOf(RangeError);
    await expect(guarded.beginVersion("job", "token", "invalid")).rejects.toBeInstanceOf(RangeError);
    await expect(guarded.publishVersion("job", "token", "invalid")).rejects.toBeInstanceOf(RangeError);
    await expect(guarded.completeJob("job", "token", "invalid")).rejects.toBeInstanceOf(RangeError);
    expect(dbCalls).toBe(0);
  });

  test("canonicalizes offset times before lease comparison and renewal", async () => {
    expect(await repository.claimJob("job", 300, "2026-07-21T08:00:00+08:00")).toEqual(expect.objectContaining({ leaseUntil: "2026-07-21T00:05:00.000Z" }));
    expect(await repository.renewJob("job", "token-1", "2026-07-21T08:01:00+08:00")).toBe("2026-07-21T00:06:00.000Z");
  });

  test("stages fenced chunks, verifies their expected count, and publishes only a complete stage", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    const chunk = { id: "chunk", documentId: "doc", indexVersion: 1, text: "text", pageNumber: 1, sectionPath: "s", paragraphIndex: 0, segmentIndex: 2, vectorId: "a".repeat(64), contentHash: "hash", createdAt: t0 };
    await repository.stageChunks("job", "token-1", [chunk], t0);
    await repository.registerGeneration("job", "token-1", 1, ["a".repeat(64)], t0);
    expect(await repository.countStagedChunks("job", "token-1", t0)).toBe(1);
    await expect(repository.publishVersion("job", "token-1", 2, t0)).rejects.toBeInstanceOf(StaleIngestionClaimError);
    expect((await repository.getDocument("doc"))!.activeVersion).toBeNull();
    await repository.publishVersion("job", "token-1", 1, t0);
    expect(await db.prepare("SELECT segment_index FROM knowledge_chunks WHERE id='chunk'").first()).toEqual({ segment_index: 2 });
  });

  test("retry release and staging cleanup are fenced and return the live job to pending", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    const chunk = { id: "chunk", documentId: "doc", indexVersion: 1, text: "text", pageNumber: 1, sectionPath: null, paragraphIndex: 0, segmentIndex: 0, vectorId: "a".repeat(64), contentHash: "hash", createdAt: t0 };
    await repository.stageChunks("job", "token-1", [chunk], t0);
    await expect(repository.cleanupStaging("job", "wrong", t0)).rejects.toBeInstanceOf(StaleIngestionClaimError);
    await repository.cleanupStaging("job", "token-1", t0);
    expect(await repository.countStagedChunks("job", "token-1", t0)).toBe(0);
    await repository.releaseJob("job", "embedding_upstream", "token-1", t0);
    expect(await row("job")).toEqual(expect.objectContaining({ status: "pending", error_code: "embedding_upstream", failure_kind: "retryable", lease_token: null, lease_until: null }));
  });

  test("numeric publish atomically marks both the document ready and job completed", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    await repository.registerGeneration("job", "token-1", 1, [], t0);
    await repository.publishVersion("job", "token-1", 0, t0);
    expect((await repository.getDocument("doc"))!.activeVersion).toBe(1);
    expect(await row("job")).toEqual(expect.objectContaining({ status: "completed", lease_token: null, lease_until: null }));
  });

  test("enumerates stored vector IDs by document and optional version", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    const chunk = { id: "chunk", documentId: "doc", indexVersion: 1, text: "text", pageNumber: 1, sectionPath: null, paragraphIndex: 0, segmentIndex: 0, vectorId: "a".repeat(64), contentHash: "hash", createdAt: t0 };
    await repository.stageChunks("job", "token-1", [chunk], t0);
    expect(await repository.listVectorIds("doc", 1)).toEqual(["a".repeat(64)]);
    expect(await repository.listVectorIds("doc")).toEqual(["a".repeat(64)]);
  });

  test("authorizes only the live generation for durable cleanup and fences a reclaimed predecessor", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    const ids = ["a".repeat(64)];
    await repository.registerGeneration("job", "token-1", 1, ids, t0);
    expect(await repository.authorizeGenerationCleanup("job", "token-1", 1, ids, "upstream", "pending", "2026-07-21T00:01:00.000Z")).toEqual({ disposition: "authorized" });
    expect(await repository.claimGenerationCleanup("job", "2026-07-21T00:01:01.000Z")).toEqual({ disposition: "acquired", cleanupToken: "token-2", vectorIds: ids });
    await repository.releaseGenerationCleanup("job", "token-2", "2026-07-21T00:01:02.000Z");

    await db.prepare("DELETE FROM ingestion_generation_cleanups WHERE job_id='job'").run();
    await repository.claimJob("job", 300, "2026-07-21T00:02:00.000Z");
    await repository.claimJob("job", 300, "2026-07-21T00:07:00.000Z");
    expect(await repository.authorizeGenerationCleanup("job", "token-3", 1, ids, "late", "pending", "2026-07-21T00:07:01.000Z")).toEqual({ disposition: "stale" });
  });

  test("ambiguous publication is recoverably idempotent and cannot authorize deletion of the active generation", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    await repository.registerGeneration("job", "token-1", 1, [], t0);
    await repository.publishVersion("job", "token-1", 0, t0);
    await expect(repository.publishVersion("job", "token-1", 0, t0)).resolves.toBeUndefined();
    expect(await repository.authorizeGenerationCleanup("job", "token-1", 1, ["a".repeat(64)], "ambiguous", "pending", t0)).toEqual({ disposition: "published" });
    expect(await db.prepare("SELECT COUNT(*) count FROM ingestion_generation_cleanups").first()).toEqual({ count: 0 });
  });

  test("terminal jobs retain failed cleanup as independently retryable work", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    await repository.registerGeneration("job", "token-1", 1, ["a".repeat(64)], t0);
    expect(await repository.authorizeGenerationCleanup("job", "token-1", 1, ["a".repeat(64)], "invalid", "failed", t0)).toEqual({ disposition: "authorized" });
    expect((await repository.claimJob("job", 300, t0)).disposition).toBe("failed");
    const cleanup = await repository.claimGenerationCleanup("job", t0);
    expect(cleanup).toEqual({ disposition: "acquired", cleanupToken: "token-2", vectorIds: ["a".repeat(64)] });
    await repository.releaseGenerationCleanup("job", "token-2", t0);
    expect((await repository.claimGenerationCleanup("job", t0)).disposition).toBe("acquired");
  });

  test("staged rows survive four cleanup failures and are removed before terminal cleanup can ack", async () => {
    await repository.claimJob("job", 300, t0); await repository.beginVersion("job", "token-1", t0);
    const chunk = { id: "chunk", documentId: "doc", indexVersion: 1, text: "text", pageNumber: 1, sectionPath: null, paragraphIndex: 0, segmentIndex: 0, vectorId: "a".repeat(64), contentHash: "hash", createdAt: t0 };
    await repository.registerGeneration("job", "token-1", 1, [chunk.vectorId], t0);
    await repository.stageChunks("job", "token-1", [chunk], t0);
    await repository.authorizeGenerationCleanup("job", "token-1", 1, [chunk.vectorId], "retry_exhausted", "failed", t0);
    for (let attempt = 0; attempt < 4; attempt++) {
      const cleanup = await repository.claimGenerationCleanup("job", t0);
      expect(cleanup.disposition).toBe("acquired");
      await repository.releaseGenerationCleanup("job", (cleanup as { cleanupToken: string }).cleanupToken, t0);
      expect(await db.prepare("SELECT COUNT(*) count FROM knowledge_chunks WHERE id='chunk'").first()).toEqual({ count: 1 });
    }
    const finalCleanup = await repository.claimGenerationCleanup("job", t0) as { disposition: "acquired"; cleanupToken: string };
    await repository.completeGenerationCleanup("job", finalCleanup.cleanupToken, t0);
    expect(await db.prepare("SELECT COUNT(*) count FROM knowledge_chunks WHERE id='chunk'").first()).toEqual({ count: 0 });
    expect(await repository.claimGenerationCleanup("job", t0)).toEqual({ disposition: "none" });
    expect((await repository.claimJob("job", 300, t0)).disposition).toBe("failed");
  });

  test("bounds claim retries and token generation during repeated CAS loss", async () => {
    let reads = 0; let writes = 0; let tokenCalls = 0;
    const fake = { prepare(sql: string) { return { bind() { return {
      async first() { reads++; return { status: "pending", attempt_count: 0, lease_until: null, error_code: null, failure_kind: null }; },
      async run() { writes++; return { meta: { changes: 0 } }; },
    }; } }; } } as unknown as D1Database;
    const guarded = new KnowledgeRepository(fake, () => { tokenCalls++; return `token-${tokenCalls}`; });
    expect(await guarded.claimJob("job", 300, t0)).toEqual({ disposition: "busy", delaySeconds: 1 });
    expect(reads).toBeLessThanOrEqual(5); expect(writes).toBeLessThanOrEqual(4); expect(tokenCalls).toBeLessThanOrEqual(4);
  });

  async function row(id: string): Promise<Record<string, unknown>> { return (await db.prepare("SELECT * FROM ingestion_jobs WHERE id=?").bind(id).first())!; }
});

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.batch(sql.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
}
