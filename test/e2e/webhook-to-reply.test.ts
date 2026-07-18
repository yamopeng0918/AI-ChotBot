import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorker } from "../../src/index";
import type { Env } from "../../src/config";
import type { QuestionJob } from "../../src/jobs/types";
import migration from "../../migrations/0001_questions.sql?raw";

const encoder = new TextEncoder();

async function signature(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return btoa(String.fromCharCode(...bytes));
}

function event(overrides: { groupId?: string; mentioned?: boolean; webhookEventId?: string } = {}) {
  return {
    type: "message",
    webhookEventId: overrides.webhookEventId ?? "event-e2e-1",
    replyToken: "reply-e2e-1",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: overrides.groupId ?? "allowed-group", userId: "line-user-1" },
    message: {
      id: "message-e2e-1",
      type: "text",
      text: "@running-bot 明天適合跑步嗎？",
      mention: { mentionees: overrides.mentioned === false ? [] : [{ isSelf: true }] },
    },
  };
}

function batch(job: QuestionJob) {
  return {
    queue: "line-question-jobs",
    messages: [{
      id: "queue-message-1",
      timestamp: new Date("2026-07-18T00:00:00.000Z"),
      body: job,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }],
  } as unknown as MessageBatch<QuestionJob>;
}

describe("signed LINE webhook to completed reply", () => {
  let mf: Miniflare;
  let db: D1Database;
  let jobs: QuestionJob[];
  let openRouterCalls: RequestInit[];
  let lineCalls: RequestInit[];

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB"] });
    db = await mf.getD1Database("DB");
    for (const statement of migration.split(";").map((sql) => sql.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    jobs = [];
    openRouterCalls = [];
    lineCalls = [];
  });

  afterEach(async () => mf.dispose());

  function fixture() {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        openRouterCalls.push(init ?? {});
        return Response.json({ model: "test/model", choices: [{ message: { content: "可以，記得補水。" } }] });
      }
      if (url.includes("api.line.me")) {
        const prepared = await db.prepare("SELECT status, prepared_status, answer, model FROM questions WHERE webhook_event_id=?1").bind("event-e2e-1").first();
        expect(prepared).toEqual({ status: "processing", prepared_status: "answered", answer: "可以，記得補水。", model: "test/model" });
        lineCalls.push(init ?? {});
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected endpoint: ${url}`);
    });
    const worker = createWorker({ fetcher, now: () => new Date("2026-07-18T00:00:00.000Z") });
    const env = {
      LINE_CHANNEL_SECRET: "channel-secret",
      LINE_CHANNEL_ACCESS_TOKEN: "line-token",
      LINE_GROUP_ID: "allowed-group",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_MODEL: "test/model",
      ANALYTICS_HASH_KEY: "analytics-key-at-least-32-bytes-long",
      MESSAGE_QUEUE: { send: async (job: QuestionJob) => { jobs.push(job); } },
      DB: db,
    } as unknown as Env;
    return { worker, env };
  }

  async function deliver(worker: ReturnType<typeof createWorker>, env: Env, webhookEvent: ReturnType<typeof event>) {
    const body = JSON.stringify({ events: [webhookEvent] });
    return worker.fetch!(new Request("https://worker.test/webhooks/line", {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": await signature(body, env.LINE_CHANNEL_SECRET) },
      body,
    }), env, {} as ExecutionContext);
  }

  it("queues an eligible mention, calls both providers, and completes one D1 row", async () => {
    const { worker, env } = fixture();
    expect((await deliver(worker, env, event())).status).toBe(200);
    expect(jobs).toHaveLength(1);

    await worker.queue!(batch(jobs[0]!), env, {} as ExecutionContext);

    expect(openRouterCalls).toHaveLength(1);
    expect(lineCalls).toHaveLength(1);
    expect(JSON.parse(String(lineCalls[0]!.body))).toEqual({ replyToken: "reply-e2e-1", messages: [{ type: "text", text: "可以，記得補水。" }] });
    const rows = await db.prepare("SELECT webhook_event_id, status, question, answer FROM questions").all();
    expect(rows.results).toEqual([{ webhook_event_id: "event-e2e-1", status: "answered", question: "@running-bot 明天適合跑步嗎？", answer: "可以，記得補水。" }]);
  });

  it.each([
    ["non-mention", event({ mentioned: false })],
    ["wrong group", event({ groupId: "other-group" })],
  ])("ignores %s without queue, network, or diagnostic writes", async (_name, webhookEvent) => {
    const { worker, env } = fixture();
    expect((await deliver(worker, env, webhookEvent)).status).toBe(200);
    expect(jobs).toHaveLength(0);
    expect(openRouterCalls).toHaveLength(0);
    expect(lineCalls).toHaveLength(0);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM questions").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not create a second visible reply for a duplicate webhookEventId", async () => {
    const { worker, env } = fixture();
    await deliver(worker, env, event());
    await deliver(worker, env, event());
    expect(jobs).toHaveLength(2);
    await worker.queue!(batch(jobs[0]!), env, {} as ExecutionContext);
    await worker.queue!(batch(jobs[1]!), env, {} as ExecutionContext);
    expect(openRouterCalls).toHaveLength(1);
    expect(lineCalls).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM questions").first<{ count: number }>())?.count).toBe(1);
  });
});
