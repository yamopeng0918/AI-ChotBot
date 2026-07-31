import { describe, expect, it, vi } from "vitest";

import { LineClient, LineReplyError } from "../src/line/client";

describe("LineClient", () => {
  it("posts one authenticated text reply to the LINE reply endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new LineClient(fetcher, "line-secret");

    await client.reply("reply-token", "hello");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/reply",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer line-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          replyToken: "reply-token",
          messages: [{ type: "text", text: "hello" }],
        }),
      }),
    );
  });

  it("posts one authenticated text push to the LINE push endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new LineClient(fetcher, "line-secret");

    await client.push("group-id", "hello");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/push",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer line-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: "group-id",
          messages: [{ type: "text", text: "hello" }],
        }),
      }),
    );
  });

  it("rejects blank reply text without making a request", async () => {
    const fetcher = vi.fn();
    const client = new LineClient(fetcher, "line-secret");

    await expect(client.reply("reply-token", " \n ")).rejects.toBeInstanceOf(LineReplyError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("limits replies to 4,500 Unicode code points including the truncation suffix", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new LineClient(fetcher, "line-secret");

    await client.reply("reply-token", "🏃".repeat(4_600));

    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect([...body.messages[0].text]).toHaveLength(4_500);
    expect(body.messages[0].text).toMatch(/…$/u);
  });

  it("normalizes non-2xx failures without exposing the access token", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("provider details", { status: 401 }));
    const client = new LineClient(fetcher, "super-secret-token");

    const error = await client.reply("reply-token", "hello").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LineReplyError);
    expect(error).toMatchObject({ status: 401, message: "LINE reply failed (401)" });
    expect(String(error)).not.toContain("super-secret-token");
  });
});
