import { describe, expect, it } from "vitest";

import { classifyLineEvent } from "../../src/admin/router";
import { isAdminCommand, parseAdminCommand, resolveAdminTarget } from "../../src/admin/commands";
import type { LineWebhookEvent } from "../../src/line/types";

const LIST_COMMAND = "@bot 管理員列表";
const ADD_MENTION_COMMAND = "@bot 管理員新增 @王小明";
const REMOVE_USER_ID_COMMAND = "@bot 管理員移除 U1234567890abcdef";
const TARGET_MENTION = "@王小明";

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
      text: LIST_COMMAND,
      mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 4 }] },
    },
    ...overrides,
  };
}

describe("parseAdminCommand", () => {
  it("parses mention-based add and userId-based remove commands", () => {
    expect(parseAdminCommand(ADD_MENTION_COMMAND)).toMatchObject({
      kind: "add",
      rawText: ADD_MENTION_COMMAND,
      target: { displayName: TARGET_MENTION },
    });
    expect(parseAdminCommand(REMOVE_USER_ID_COMMAND)).toEqual({
      kind: "remove",
      rawText: REMOVE_USER_ID_COMMAND,
      target: { userId: "U1234567890abcdef", displayName: "U1234567890abcdef" },
    });
    expect(parseAdminCommand(LIST_COMMAND)).toEqual({
      kind: "list",
      rawText: LIST_COMMAND,
    });
  });

  it("rejects malformed mention commands with extra text after the target", () => {
    expect(parseAdminCommand(`${ADD_MENTION_COMMAND} extra`)).toBeNull();
    expect(
      isAdminCommand(
        textEvent({
          message: {
            id: "message-malformed",
            type: "text",
            text: `${ADD_MENTION_COMMAND} extra`,
            mention: {
              mentionees: [
                { type: "user", isSelf: true, index: 0, length: 4 },
                { type: "user", userId: "U-target-1", index: ADD_MENTION_COMMAND.lastIndexOf(TARGET_MENTION), length: TARGET_MENTION.length },
              ],
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns null for non-admin text", () => {
    expect(parseAdminCommand("@bot run tomorrow?")).toBeNull();
    expect(parseAdminCommand("管理員列表")).toBeNull();
    expect(parseAdminCommand("@bot 可以幫我查天氣嗎")).toBeNull();
  });

  it("is case-sensitive on the exact Chinese action words", () => {
    expect(parseAdminCommand(ADD_MENTION_COMMAND)).not.toBeNull();
    expect(parseAdminCommand("@bot 管理員 新增 @王小明")).toBeNull();
    expect(parseAdminCommand("@bot 管理員增加 @王小明")).toBeNull();
    expect(parseAdminCommand("@bot 管理員移掉 @王小明")).toBeNull();
    expect(parseAdminCommand("@bot 管理員清單")).toBeNull();
  });
});

describe("resolveAdminTarget", () => {
  it("preserves the mention text as displayName when resolving a mention target", () => {
    const command = parseAdminCommand(ADD_MENTION_COMMAND);
    expect(command).not.toBeNull();

    const target = resolveAdminTarget(
      textEvent({
        message: {
          id: "message-mention",
          type: "text",
          text: ADD_MENTION_COMMAND,
          mention: {
            mentionees: [
              { type: "user", isSelf: true, index: 0, length: 4 },
              { type: "user", userId: "U-target-1", index: ADD_MENTION_COMMAND.lastIndexOf(TARGET_MENTION), length: TARGET_MENTION.length },
            ],
          },
        },
      }),
      command!,
    );

    expect(target).toEqual({ userId: "U-target-1", displayName: TARGET_MENTION });
  });

  it("binds the resolved target to the actual trailing mention token", () => {
    const command = parseAdminCommand(ADD_MENTION_COMMAND);
    expect(command).not.toBeNull();

    const targetIndex = ADD_MENTION_COMMAND.lastIndexOf(TARGET_MENTION);
    const target = resolveAdminTarget(
      textEvent({
        message: {
          id: "message-multi-mention",
          type: "text",
          text: ADD_MENTION_COMMAND,
          mention: {
            mentionees: [
              { type: "user", isSelf: true, index: 0, length: 4 },
              { type: "user", userId: "U-wrong", index: 1, length: 3 },
              { type: "user", userId: "U-target-2", index: targetIndex, length: TARGET_MENTION.length },
            ],
          },
        },
      }),
      command!,
    );

    expect(target).toEqual({ userId: "U-target-2", displayName: TARGET_MENTION });
  });

  it("falls back to the raw userId as displayName when no alias is present", () => {
    const command = parseAdminCommand(REMOVE_USER_ID_COMMAND);
    expect(command).not.toBeNull();

    expect(resolveAdminTarget(textEvent(), command!)).toEqual({
      userId: "U1234567890abcdef",
      displayName: "U1234567890abcdef",
    });
  });

  it("never infers a target from a private message", () => {
    const command = parseAdminCommand(ADD_MENTION_COMMAND);
    expect(command).not.toBeNull();

    expect(
      resolveAdminTarget(
        textEvent({
          source: { type: "user", userId: "sender-1" },
          message: {
            id: "message-private",
            type: "text",
            text: ADD_MENTION_COMMAND,
            mention: {
              mentionees: [
                { type: "user", isSelf: true, index: 0, length: 4 },
                { type: "user", userId: "U-target-1", index: ADD_MENTION_COMMAND.lastIndexOf(TARGET_MENTION), length: TARGET_MENTION.length },
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
    expect(isAdminCommand(textEvent({ message: { id: "message-list", type: "text", text: LIST_COMMAND } }))).toBe(true);
    expect(isAdminCommand(textEvent({ message: { id: "message-q", type: "text", text: "@bot run tomorrow?" } }))).toBe(false);
  });

  it("classifies events as admin command, question, or ignored", () => {
    expect(classifyLineEvent(textEvent({ message: { id: "message-admin", type: "text", text: LIST_COMMAND } }))).toBe(
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
