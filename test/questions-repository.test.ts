import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import migrationSql from "../migrations/0001_questions.sql?raw";
import { QuestionsRepository, StaleClaimError, pseudonymizeUserId, type QuestionRecord } from "../src/storage/questions";

let mf: Miniflare; let db: D1Database;
beforeAll(async () => { mf = new Miniflare({ modules: true, script: "export default {}", compatibilityDate: "2026-07-17", d1Databases: { DB: "diagnostics" } }); db = await mf.getD1Database("DB") as D1Database; await db.exec(migrationSql.replace(/\r?\n/g, " ")); });
afterAll(async () => { await mf.dispose(); });
const receivedAt = "2026-07-18T00:00:00.000Z", expiresAt = "2026-08-17T00:00:00.000Z";
const record = (id: string): QuestionRecord => ({ webhookEventId: id, userKey: null, question: "q", answer: "a", status: "answered", model: "m", createdAt: receivedAt, expiresAt });

describe("QuestionsRepository with real Miniflare D1", () => {
  it("fences stale prepare, complete, and release after another worker reclaims", async () => {
    const a = new QuestionsRepository(db, () => receivedAt, () => "lease-a");
    const claimA = await a.claim("race", "2026-07-18T00:01:00.000Z", receivedAt); expect(claimA).toMatchObject({ state: "claimed", leaseToken: "lease-a", createdAt: receivedAt, expiresAt });
    const b = new QuestionsRepository(db, () => "2026-07-18T00:02:00.000Z", () => "lease-b");
    const claimB = await b.claim("race", "2026-07-18T00:03:00.000Z", "2026-07-19T00:00:00.000Z"); expect(claimB).toMatchObject({ state: "claimed", leaseToken: "lease-b", createdAt: receivedAt, expiresAt });
    await expect(a.prepare(record("race"), "answered", "lease-a")).rejects.toBeInstanceOf(StaleClaimError);
    await expect(a.complete(record("race"), "lease-a")).rejects.toBeInstanceOf(StaleClaimError);
    await expect(a.release("race", "lease-a")).rejects.toBeInstanceOf(StaleClaimError);
    await b.prepare(record("race"), "answered", "lease-b"); await b.complete(record("race"), "lease-b");
    await expect(b.claim("race", "2026-07-18T00:04:00.000Z", receivedAt)).resolves.toEqual({ state: "completed" });
  });
  it("returns busy lease time and preserves prepared text and immutable retention on reclaim", async () => {
    const first = new QuestionsRepository(db, () => receivedAt, () => "first"); await first.claim("resume", "2026-07-18T00:01:00.000Z", receivedAt); await first.prepare(record("resume"), "answered", "first");
    const busy = await first.claim("resume", "2026-07-18T00:01:00.000Z", receivedAt); expect(busy).toEqual({ state: "busy", leaseUntil: "2026-07-18T00:01:00.000Z" });
    const retry = new QuestionsRepository(db, () => "2026-07-18T00:02:00.000Z", () => "second"); const reclaimed = await retry.claim("resume", "2026-07-18T00:03:00.000Z", "2026-07-20T00:00:00.000Z"); expect(reclaimed).toMatchObject({ state: "claimed", createdAt: receivedAt, expiresAt, prepared: { text: "a", model: "m", status: "answered" } });
  });
  it("keeps first-delivery timestamps when reply_failed is reclaimed", async () => {
    const first = new QuestionsRepository(db, () => receivedAt, () => "failed-first"); await first.claim("failed-retention", "2026-07-18T00:01:00.000Z", receivedAt); await first.prepare(record("failed-retention"), "answered", "failed-first"); await first.complete({ ...record("failed-retention"), status: "reply_failed" }, "failed-first");
    const retry = new QuestionsRepository(db, () => "2026-07-21T00:00:00.000Z", () => "failed-second"); await expect(retry.claim("failed-retention", "2026-07-21T00:01:00.000Z", "2026-07-21T00:00:00.000Z")).resolves.toMatchObject({ state: "claimed", createdAt: receivedAt, expiresAt, prepared: { text: "a" } });
  });
  it("purges only expired rows and never stores a raw user ID", async () => {
    const repo = new QuestionsRepository(db, () => "2026-06-01T00:00:00.000Z", () => "old-token"); await repo.claim("old", "2026-06-01T00:01:00.000Z", "2026-06-01T00:00:00.000Z");
    expect(await repo.purgeExpired("2026-07-02T00:00:00.000Z")).toBe(1);
    const key = await pseudonymizeUserId("raw-user-id", "secret"); expect(key).toMatch(/^[a-f0-9]{64}$/); expect(key).not.toContain("raw-user-id"); expect(await pseudonymizeUserId(null, "secret")).toBeNull();
  });
});
