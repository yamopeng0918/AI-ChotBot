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

class FakeReceiptDatabase {
  readonly claims = new Map<string, string>();

  prepare(query: string) {
    return {
      bind: (webhookEventId: string, receivedAt?: string) => ({
        run: async () => {
          if (query.startsWith("INSERT")) {
            if (this.claims.has(webhookEventId)) return { meta: { changes: 0 } };
            this.claims.set(webhookEventId, receivedAt!);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE")) {
            const changes = this.claims.delete(webhookEventId) ? 1 : 0;
            return { meta: { changes } };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      }),
    };
  }
}

async function post(
  body: string,
  send: ReturnType<typeof vi.fn>,
  db = new FakeReceiptDatabase(),
) {
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
      DB: db,
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

  it("keeps successful claims while releasing a failed event for redelivery", async () => {
    const db = new FakeReceiptDatabase();
    const eventA = eligibleEvent();
    const eventB = {
      ...eligibleEvent(),
      webhookEventId: "event-2",
      replyToken: "reply-2",
      message: { ...eligibleEvent().message, id: "message-2" },
    };
    const body = JSON.stringify({ events: [eventA, eventB] });
    const send = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue(undefined);

    expect((await post(body, send, db)).status).toBe(503);
    expect((await post(body, send, db)).status).toBe(200);

    expect(send).toHaveBeenCalledTimes(3);
    const jobs = send.mock.calls.map(([job]) => job);
    expect(jobs.map((job) => job.webhookEventId)).toEqual([
      "event-1",
      "event-2",
      "event-2",
    ]);
    expect(db.claims.get("event-1")).toBe(jobs[0].receivedAt);
    expect(db.claims.get("event-2")).toBe(jobs[2].receivedAt);
  });

  it("atomically claims a duplicate webhook ID only once", async () => {
    const db = new FakeReceiptDatabase();
    const send = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify({ events: [eligibleEvent()] });

    const responses = await Promise.all([post(body, send, db), post(body, send, db)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
