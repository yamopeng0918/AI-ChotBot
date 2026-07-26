import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

import migrationSql from "../../migrations/0002_group_admins.sql?raw";
import { GroupAdminsRepository } from "../../src/admin/group-admins";
import { createWorker } from "../../src/index";
import type { Env } from "../../src/config";
import type { TelemetryEvent, TelemetryLogger } from "../../src/telemetry/logger";

const encoder = new TextEncoder();

const ADD_SUCCESS = "已新增管理員。";
const LIST_PREFIX = "目前管理員列表：";
const UNAUTHORIZED = "你沒有權限執行這個指令。";
const WRONG_CHAT_TYPE = "這個指令只能在群組中使用。";
const LIST_COMMAND = "@bot 管理員列表";
const TARGET_MENTION = "@王小明";
const ADD_COMMAND = `@bot 管理員新增 ${TARGET_MENTION}`;

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return btoa(String.fromCharCode(...bytes));
}

function groupEvent(text: string, userId = "U-seed-1") {
  return {
    type: "message",
    webhookEventId: "event-1",
    replyToken: "reply-1",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: "group-1", userId },
    message: {
      id: "message-1",
      type: "text",
      text,
      mention: {
        mentionees: [
          { type: "user", isSelf: true, index: 0, length: 4 },
          { type: "user", userId: "U-new-1", index: text.lastIndexOf(TARGET_MENTION), length: TARGET_MENTION.length },
        ],
      },
    },
  };
}

function privateEvent(text: string, userId = "U-seed-1") {
  return {
    type: "message",
    webhookEventId: "event-private",
    replyToken: "reply-private",
    timestamp: 1_720_000_000_000,
    source: { type: "user", userId },
    message: {
      id: "message-private",
      type: "text",
      text,
      mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 4 }] },
    },
  };
}

describe("admin webhook integration", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default {}",
      compatibilityDate: "2026-07-17",
      d1Databases: { DB: "group-admins" },
    });
    db = (await mf.getD1Database("DB")) as D1Database;
    await db.exec(migrationSql.replace(/\r?\n/g, " "));
  });

  afterEach(async () => {
    await mf.dispose();
  });

  async function deliver(
    event: Record<string, unknown>,
    overrides: Partial<Env> = {},
    options: { lineStatus?: number; logger?: TelemetryLogger } = {},
  ) {
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const lineCalls: Array<{ body: unknown; headers: HeadersInit | undefined }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      lineCalls.push({ body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
      return new Response(null, { status: options.lineStatus ?? 200 });
    });

    const worker = createWorker({ logger: options.logger });
    const env = {
      LINE_CHANNEL_SECRET: "secret",
      LINE_CHANNEL_ACCESS_TOKEN: "line-token",
      LINE_GROUP_ID: "group-1",
      ANALYTICS_HASH_KEY: "analytics-key-at-least-32-bytes-long",
      GROUP_ADMINS_BOOTSTRAP_JSON: JSON.stringify({
        "group-1": [{ userId: "U-seed-1", displayName: "Seeder" }],
      }),
      MESSAGE_QUEUE: { send: queueSend },
      DB: db,
      FETCHER: fetcher,
      AI: { run: vi.fn() } as never,
      ...overrides,
    } as unknown as Env;

    const body = JSON.stringify({ events: [event] });
    const response = await worker.fetch!(
      new Request("https://bot.test/webhooks/line", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": await sign(body, env.LINE_CHANNEL_SECRET),
        },
        body,
      }),
      env,
      {} as never,
    );

    return { response, queueSend, lineCalls, env };
  }

  it("lets a bootstrapped group admin add another admin and replies with success", async () => {
    const { response, queueSend, lineCalls } = await deliver(groupEvent(ADD_COMMAND));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(queueSend).not.toHaveBeenCalled();
    expect(lineCalls).toEqual([
      {
        body: { replyToken: "reply-1", messages: [{ type: "text", text: ADD_SUCCESS }] },
        headers: expect.any(Object),
      },
    ]);
    await expect(new GroupAdminsRepository(db).list("group-1")).resolves.toEqual([
      expect.objectContaining({ userId: "U-seed-1", displayName: "Seeder" }),
      expect.objectContaining({ userId: "U-new-1", displayName: TARGET_MENTION, source: "command" }),
    ]);
  });

  it("rejects non-admin senders with the unauthorized reply", async () => {
    const { response, queueSend, lineCalls } = await deliver(groupEvent(LIST_COMMAND, "U-intruder"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(queueSend).not.toHaveBeenCalled();
    expect(lineCalls).toEqual([
      {
        body: { replyToken: "reply-1", messages: [{ type: "text", text: UNAUTHORIZED }] },
        headers: expect.any(Object),
      },
    ]);
    await expect(new GroupAdminsRepository(db).list("group-1")).resolves.toEqual([
      expect.objectContaining({ userId: "U-seed-1", displayName: "Seeder" }),
    ]);
  });

  it("lets malformed group admin-like text fall through to the normal queue path", async () => {
    const { response, queueSend, lineCalls } = await deliver(groupEvent(`${ADD_COMMAND} extra`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
    expect(lineCalls).toHaveLength(0);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: `${ADD_COMMAND} extra`,
        groupId: "group-1",
        userId: "U-seed-1",
      }),
    );
  });

  it("replies to list commands with the current group admin list", async () => {
    await new GroupAdminsRepository(db, () => "2026-07-24T00:00:00.000Z").upsert(
      "group-1",
      { userId: "U-seed-1", displayName: "Seeder" },
      "bootstrap",
    );
    await new GroupAdminsRepository(db, () => "2026-07-24T00:00:00.000Z").upsert(
      "group-1",
      { userId: "U-added-1", displayName: "@王小明" },
      "command",
    );

    const { response, queueSend, lineCalls } = await deliver(groupEvent(LIST_COMMAND, "U-added-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(queueSend).not.toHaveBeenCalled();
    expect(lineCalls).toHaveLength(1);
    expect((lineCalls[0]?.body as { messages: Array<{ text: string }> }).messages[0]?.text).toEqual(
      expect.stringContaining(LIST_PREFIX),
    );
    expect((lineCalls[0]?.body as { messages: Array<{ text: string }> }).messages[0]?.text).toEqual(
      expect.stringContaining("U-added-1"),
    );
  });

  it("rejects private-chat admin commands with the wrong-chat-type reply", async () => {
    const { response, queueSend, lineCalls } = await deliver(privateEvent(LIST_COMMAND));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(queueSend).not.toHaveBeenCalled();
    expect(lineCalls).toHaveLength(1);
    expect((lineCalls[0]?.body as { messages: Array<{ text: string }> }).messages[0]?.text).toBe(WRONG_CHAT_TYPE);
  });

  it("emits correlated telemetry for a successful synchronous admin reply", async () => {
    const events: TelemetryEvent[] = [];

    const { response } = await deliver(
      groupEvent(LIST_COMMAND),
      {},
      { logger: { emit: (event) => events.push(event) } },
    );

    expect(response.status).toBe(200);
    expect(events).toEqual([
      expect.objectContaining({
        event: "admin.reply.completed",
        stage: "line",
        outcome: "success",
        webhookEventId: "event-1",
      }),
    ]);
  });

  it("classifies a synchronous admin reply failure without sensitive LINE values", async () => {
    const events: TelemetryEvent[] = [];

    const { response } = await deliver(
      groupEvent(LIST_COMMAND),
      {},
      {
        lineStatus: 503,
        logger: { emit: (event) => events.push(event) },
      },
    );

    expect(response.status).toBe(503);
    expect(events).toEqual([
      expect.objectContaining({
        event: "admin.reply.failed",
        stage: "line",
        outcome: "failed",
        webhookEventId: "event-1",
        errorType: "line_reply_failed",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("reply-1");
    expect(JSON.stringify(events)).not.toContain("U-seed-1");
    expect(JSON.stringify(events)).not.toContain("group-1");
  });
});
