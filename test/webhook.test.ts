import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

import worker, { createWorker } from "../src/index";
import { parseAdminCommand } from "../src/admin/commands";
import type { LineWebhookEvent } from "../src/line/types";
import migrationSql from "../migrations/0002_group_admins.sql?raw";

const encoder = new TextEncoder();
let mf: Miniflare | undefined;
let adminDb: D1Database | undefined;

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

function eligibleEvent(): LineWebhookEvent {
  return {
    type: "message",
    webhookEventId: "event-1",
    replyToken: "reply-1",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    message: {
      id: "message-1",
      type: "text",
      text: "@bot run tomorrow?",
      mention: { mentionees: [{ isSelf: true }] },
    },
  };
}

async function post(body: string, send: ReturnType<typeof vi.fn>) {
  return worker.fetch(
    new Request("https://bot.test/webhooks/line", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-line-signature": await sign(body, "secret"),
      },
      body,
    }),
    {
      LINE_CHANNEL_SECRET: "secret",
      LINE_CHANNEL_ACCESS_TOKEN: "line-token",
      LINE_GROUP_ID: "group-1",
      GROUP_ADMINS_BOOTSTRAP_JSON: "",
      FETCHER: vi.fn(async () => new Response(null, { status: 200 })),
      DB: adminDb,
      MESSAGE_QUEUE: { send },
    } as never,
    {} as never,
  );
}

describe("POST /webhooks/line queue publication", () => {
  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default {}",
      compatibilityDate: "2026-07-17",
      d1Databases: { DB: "group-admins" },
    });
    adminDb = (await mf.getD1Database("DB")) as D1Database;
    await adminDb.exec(migrationSql.replace(/\r?\n/g, " "));
  });

  afterEach(async () => {
    if (mf) await mf.dispose();
    mf = undefined;
    adminDb = undefined;
  });

  it("uses an injected queue sender instead of the environment binding", async () => {
    const injectedSend = vi.fn().mockResolvedValue(undefined);
    const envSend = vi.fn().mockResolvedValue(undefined);
    const injectedWorker = createWorker({ queue: { send: injectedSend } });
    const body = JSON.stringify({ events: [eligibleEvent()] });
    const response = await injectedWorker.fetch(new Request("https://bot.test/webhooks/line", {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": await sign(body, "secret") },
      body,
    }), { LINE_CHANNEL_SECRET: "secret", LINE_GROUP_ID: "group-1", MESSAGE_QUEUE: { send: envSend } } as never, {} as never);

    expect(response.status).toBe(200);
    expect(injectedSend).toHaveBeenCalledOnce();
    expect(envSend).not.toHaveBeenCalled();
  });

  it("logs only group IDs and performs no work in exact discovery mode", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify({ events: [eligibleEvent(), { ...eligibleEvent(), webhookEventId: "event-2" }] });

    const response = await worker.fetch(new Request("https://bot.test/webhooks/line", {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": await sign(body, "secret") },
      body,
    }), { LINE_CHANNEL_SECRET: "secret", LINE_GROUP_ID: "__DISCOVER__", MESSAGE_QUEUE: { send } } as never, {} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls).toEqual([["group-1"], ["group-1"]]);
    expect(send).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("does not enable discovery for near-sentinel values", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = JSON.stringify({ events: [eligibleEvent()] });
    await worker.fetch(new Request("https://bot.test/webhooks/line", {
      method: "POST", headers: { "x-line-signature": await sign(body, "secret") }, body,
    }), { LINE_CHANNEL_SECRET: "secret", LINE_GROUP_ID: "__discover__", MESSAGE_QUEUE: { send } } as never, {} as never);
    expect(info).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("queues one QuestionJob for one eligible mention", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await post(JSON.stringify({ events: [eligibleEvent()] }), send);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      webhookEventId: "event-1",
      replyToken: "reply-1",
      groupId: "group-1",
      userId: "user-1",
      messageId: "message-1",
      text: "@bot run tomorrow?",
      timestamp: 1_720_000_000_000,
      receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
  });

  it("never queues ineligible events", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ineligible = eligibleEvent();
    ineligible.source!.groupId = "other-group";

    const response = await post(JSON.stringify({ events: [ineligible] }), send);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not queue admin commands that mention the bot", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const adminCommand = eligibleEvent();
    adminCommand.message!.text = "@bot 管理員列表";

    const response = await post(JSON.stringify({ events: [adminCommand] }), send);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("queues malformed admin-like mention text through the normal mention path", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const malformedAdminLike = eligibleEvent();
    malformedAdminLike.message!.text = "@bot 管理員新增 @王小明 extra";
    const targetMention = "@王小明";
    malformedAdminLike.message!.mention = {
      mentionees: [
        { type: "user", isSelf: true, index: 0, length: 4 },
        {
          type: "user",
          userId: "user-2",
          index: malformedAdminLike.message!.text.lastIndexOf(targetMention),
          length: targetMention.length,
        },
      ],
    };
    expect(parseAdminCommand(malformedAdminLike.message!.text)).not.toBeNull();

    const response = await post(JSON.stringify({ events: [malformedAdminLike] }), send);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      webhookEventId: "event-1",
      text: "@bot 管理員新增 @王小明 extra",
    });
  });

  it("returns 400 for malformed signed JSON", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await post("not-json", send);

    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 503 when queue publication fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const response = await post(JSON.stringify({ events: [eligibleEvent()] }), send);

    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("may enqueue the same stable webhook ID again when LINE redelivers", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify({ events: [eligibleEvent()] });

    expect((await post(body, send)).status).toBe(200);
    expect((await post(body, send)).status).toBe(200);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([job]) => job.webhookEventId)).toEqual([
      "event-1",
      "event-1",
    ]);
  });
});
