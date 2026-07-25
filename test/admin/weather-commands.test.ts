import { describe, expect, it } from "vitest";

import { isAdminCommand, parseAdminCommand } from "../../src/admin/commands";
import type { LineWebhookEvent } from "../../src/line/types";

function event(text: string): LineWebhookEvent {
  return {
    type: "message",
    webhookEventId: "event-1",
    replyToken: "reply-1",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: "group-1", userId: "U1" },
    message: {
      id: "message-1",
      type: "text",
      text,
      mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 4 }] },
    },
  };
}

describe("weather admin commands", () => {
  it("parses the weather-setting commands", () => {
    expect(parseAdminCommand("@bot 設定預設城市 台北")).toEqual({
      kind: "set-weather-city",
      city: "台北",
      rawText: "@bot 設定預設城市 台北",
    });
    expect(parseAdminCommand("@bot 查看預設城市")).toEqual({
      kind: "show-weather-city",
      rawText: "@bot 查看預設城市",
    });
    expect(parseAdminCommand("@bot 清除預設城市")).toEqual({
      kind: "clear-weather-city",
      rawText: "@bot 清除預設城市",
    });
  });

  it("treats weather commands as admin commands", () => {
    expect(isAdminCommand(event("@bot 設定預設城市 台北"))).toBe(true);
    expect(isAdminCommand(event("@bot 查看預設城市"))).toBe(true);
  });
});
