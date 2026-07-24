import { describe, expect, it } from "vitest";

import { parseAdminCommand, resolveAdminTarget, isAdminCommand } from "../../src/admin/commands";
import { classifyLineEvent } from "../../src/admin/router";
import type { LineWebhookEvent } from "../../src/line/types";

function textEvent(overrides: Partial<LineWebhookEvent> = {}): LineWebhookEvent {
  return {
    type: "message",
    webhookEventId: "event-1",
    replyToken: "reply-1",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: "group-1", userId: "sender-1" },
    message: {
      id: "message-1",
      type: "text",
      text: "@bot 管理員列表",
      mention: { mentionees: [{ type: "user", isSelf: true }] },
    },
    ...overrides,
  };
}

describe("parseAdminCommand", () => {
  it("parses mention-based add and userId-based remove commands", () => {
    expect(parseAdminCommand("@bot 管理員新增 @王小明")).toMatchObject({
      kind: "add",
      rawText: "@bot 管理員新增 @王小明",
      target: { displayName: "@王小明" },
    });
    expect(parseAdminCommand("@bot 管理員移除 U1234567890abcdef")).toEqual({
      kind: "remove",
      rawText: "@bot 管理員移除 U1234567890abcdef",
      target: { userId: "U1234567890abcdef", displayName: "U1234567890abcdef" },
    });
    expect(parseAdminCommand("@bot 管理員列表")).toEqual({
      kind: "list",
      rawText: "@bot 管理員列表",
    });
  });

  it("returns null for non-admin text", () => {
    expect(parseAdminCommand("@bot run tomorrow?")).toBeNull();
    expect(parseAdminCommand("管理員列表")).toBeNull();
    expect(parseAdminCommand("@bot 可以幫我查天氣嗎")).toBeNull();
  });

  it("is case-sensitive on the exact Chinese action words", () => {
    expect(parseAdminCommand("@bot 管理員新增 @王小明")).not.toBeNull();
    expect(parseAdminCommand("@bot 管理員 新增 @王小明")).toBeNull();
    expect(parseAdminCommand("@bot 管理員增加 @王小明")).toBeNull();
    expect(parseAdminCommand("@bot 管理員移掉 @王小明")).toBeNull();
    expect(parseAdminCommand("@bot 管理員清單")).toBeNull();
  });
});

describe("resolveAdminTarget", () => {
  it("preserves the mention text as displayName when resolving a mention target", () => {
    const command = parseAdminCommand("@bot 管理員新增 @王小明");
    expect(command).not.toBeNull();

    const target = resolveAdminTarget(
      textEvent({
        message: {
          id: "message-mention",
          type: "text",
          text: "@bot 管理員新增 @王小明",
          mention: {
            mentionees: [
              { type: "user", isSelf: true },
              { type: "user", userId: "U-target-1" },
            ],
          },
        },
      }),
      command!,
    );

    expect(target).toEqual({ userId: "U-target-1", displayName: "@王小明" });
  });

  it("falls back to the raw userId as displayName when no alias is present", () => {
    const command = parseAdminCommand("@bot 管理員移除 U1234567890abcdef");
    expect(command).not.toBeNull();

    expect(resolveAdminTarget(textEvent(), command!)).toEqual({
      userId: "U1234567890abcdef",
      displayName: "U1234567890abcdef",
    });
  });

  it("never infers a target from a private message", () => {
    const command = parseAdminCommand("@bot 管理員新增 @王小明");
    expect(command).not.toBeNull();

    expect(
      resolveAdminTarget(
        textEvent({
          source: { type: "user", userId: "sender-1" },
          message: {
            id: "message-private",
            type: "text",
            text: "@bot 管理員新增 @王小明",
            mention: {
              mentionees: [
                { type: "user", isSelf: true },
                { type: "user", userId: "U-target-1" },
              ],
            },
          },
        }),
        command!,
      ),
    ).toBeNull();
  });
});

describe("admin command routing helpers", () => {
  it("detects admin-command events without classifying plain questions as admin commands", () => {
    expect(isAdminCommand(textEvent({ message: { id: "message-list", type: "text", text: "@bot 管理員列表" } }))).toBe(true);
    expect(isAdminCommand(textEvent({ message: { id: "message-q", type: "text", text: "@bot run tomorrow?" } }))).toBe(false);
  });

  it("classifies events as admin command, question, or ignored", () => {
    expect(classifyLineEvent(textEvent({ message: { id: "message-admin", type: "text", text: "@bot 管理員列表" } }))).toBe(
      "admin-command",
    );
    expect(
      classifyLineEvent(
        textEvent({
          message: {
            id: "message-question",
            type: "text",
            text: "@bot run tomorrow?",
            mention: { mentionees: [{ type: "user", isSelf: true }] },
          },
        }),
      ),
    ).toBe("question");
    expect(
      classifyLineEvent(
        textEvent({
          type: "follow",
          message: undefined,
        }),
      ),
    ).toBe("ignored");
  });
});
