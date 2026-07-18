import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { verifyLineSignature } from "../src/line/signature";

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

describe("verifyLineSignature", () => {
  const body = JSON.stringify({ destination: "bot", events: [] });
  const secret = "fixed-channel-secret";

  it("accepts a valid signature", async () => {
    expect(await verifyLineSignature(body, await sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature when the body changes", async () => {
    expect(await verifyLineSignature(`${body} `, await sign(body, secret), secret)).toBe(false);
  });

  it("rejects an empty signature", async () => {
    expect(await verifyLineSignature(body, "", secret)).toBe(false);
  });
});

describe("POST /webhooks/line signature boundary", () => {
  it("requires the signature header", async () => {
    const response = await worker.fetch(
      new Request("https://bot.test/webhooks/line", { method: "POST", body: "{}" }),
      { LINE_CHANNEL_SECRET: "secret", LINE_GROUP_ID: "group-1" } as never,
      {} as never,
    );
    expect(response.status).toBe(401);
  });

  it("rejects an invalid signature before parsing JSON", async () => {
    const response = await worker.fetch(
      new Request("https://bot.test/webhooks/line", {
        method: "POST",
        headers: { "content-type": "application/json", "x-line-signature": "invalid" },
        body: "not-json",
      }),
      { LINE_CHANNEL_SECRET: "secret", LINE_GROUP_ID: "group-1" } as never,
      {} as never,
    );

    expect(response.status).toBe(401);
  });

  it("reports the number of eligible messages after verification", async () => {
    const body = JSON.stringify({
      events: [{
        type: "message",
        webhookEventId: "event-1",
        replyToken: "reply-1",
        timestamp: 1,
        source: { type: "group", groupId: "group-1", userId: "user-1" },
        message: {
          id: "message-1",
          type: "text",
          text: "@bot hi",
          mention: { mentionees: [{ isSelf: true }] },
        },
      }],
    });
    const response = await worker.fetch(
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
        MESSAGE_QUEUE: { send: async () => undefined },
      } as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
  });
});
