import { describe, expect, it } from "vitest";

import { selectMentionedMessages } from "../src/line/events";
import type { LineWebhookBody } from "../src/line/types";

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    webhookEventId: "event-valid",
    replyToken: "reply-valid",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: "allowed-group", userId: "user-1" },
    message: {
      id: "message-valid",
      type: "text",
      text: "@bot run tomorrow?",
      mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
    },
    ...overrides,
  };
}

describe("selectMentionedMessages", () => {
  it("returns only eligible self mentions from the allowed group", () => {
    const valid = messageEvent();
    const noMention = messageEvent({
      webhookEventId: "event-plain",
      message: { id: "message-plain", type: "text", text: "hello" },
    });
    const mentionsOtherUser = messageEvent({
      webhookEventId: "event-other",
      message: {
        id: "message-other",
        type: "text",
        text: "@friend hello",
        mention: { mentionees: [{ type: "user", isSelf: false }] },
      },
    });
    const wrongGroup = messageEvent({
      webhookEventId: "event-wrong-group",
      source: { type: "group", groupId: "other-group", userId: "user-2" },
    });
    const privateChat = messageEvent({
      webhookEventId: "event-private",
      source: { type: "user", userId: "user-3" },
    });
    const sticker = messageEvent({
      webhookEventId: "event-sticker",
      message: { id: "message-sticker", type: "sticker", packageId: "1", stickerId: "2" },
    });
    const missingUserId = messageEvent({
      webhookEventId: "event-anonymous",
      replyToken: "reply-anonymous",
      source: { type: "group", groupId: "allowed-group" },
      message: {
        id: "message-anonymous",
        type: "text",
        text: "@bot anonymous",
        mention: { mentionees: [{ type: "user", isSelf: true }] },
      },
    });

    const payload = {
      destination: "bot-user-id",
      events: [valid, noMention, mentionsOtherUser, wrongGroup, privateChat, sticker, missingUserId],
    } as LineWebhookBody;

    expect(selectMentionedMessages(payload, "allowed-group")).toEqual([
      {
        webhookEventId: "event-valid",
        replyToken: "reply-valid",
        groupId: "allowed-group",
        userId: "user-1",
        messageId: "message-valid",
        text: "@bot run tomorrow?",
        timestamp: 1_720_000_000_000,
      },
      {
        webhookEventId: "event-anonymous",
        replyToken: "reply-anonymous",
        groupId: "allowed-group",
        userId: null,
        messageId: "message-anonymous",
        text: "@bot anonymous",
        timestamp: 1_720_000_000_000,
      },
    ]);
  });

  it("rejects an otherwise valid event with an empty reply token", () => {
    const payload = { events: [messageEvent({ replyToken: "" })] } as LineWebhookBody;
    expect(selectMentionedMessages(payload, "allowed-group")).toEqual([]);
  });
});
