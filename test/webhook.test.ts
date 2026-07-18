import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";

const encoder = new TextEncoder();

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

function eligibleEvent() {
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
      LINE_GROUP_ID: "group-1",
      MESSAGE_QUEUE: { send },
    } as never,
    {} as never,
  );
}

describe("POST /webhooks/line queue publication", () => {
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
    ineligible.source.groupId = "other-group";

    const response = await post(JSON.stringify({ events: [ineligible] }), send);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 0 });
    expect(send).not.toHaveBeenCalled();
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
});
