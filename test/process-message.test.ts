import { describe, expect, it, vi } from "vitest";

import { AnswerUnavailableError } from "../src/answers/openrouter";
import type { QuestionJob } from "../src/jobs/types";
import { processQuestion } from "../src/jobs/process-message";
import worker from "../src/index";
import { LineReplyError } from "../src/line/client";

const job: QuestionJob = {
  webhookEventId: "event-1",
  replyToken: "reply-1",
  groupId: "group-1",
  userId: "user-1",
  messageId: "message-1",
  text: "Where should I run?",
  timestamp: 1,
  receivedAt: "2026-07-18T00:00:00.000Z",
};

function dependencies(answer = vi.fn().mockResolvedValue({
  text: "Try the riverside.", model: "model", inputTokens: 1, outputTokens: 2,
})) {
  return {
    answerService: { answer },
    lineClient: { reply: vi.fn().mockResolvedValue(undefined) },
    recorder: { record: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("processQuestion", () => {
  it("answers once and replies once", async () => {
    const deps = dependencies();

    await expect(processQuestion(job, deps)).resolves.toEqual({ status: "answered" });
    expect(deps.answerService.answer).toHaveBeenCalledOnce();
    expect(deps.answerService.answer).toHaveBeenCalledWith({ question: job.text, locale: "zh-TW" });
    expect(deps.lineClient.reply).toHaveBeenCalledOnce();
    expect(deps.lineClient.reply).toHaveBeenCalledWith(job.replyToken, "Try the riverside.");
  });

  it.each(["rate_limited", "timeout", "provider_error"] as const)(
    "delivers the provider-unavailable message for %s",
    async (reason) => {
      const deps = dependencies(vi.fn().mockRejectedValue(new AnswerUnavailableError(reason)));

      await expect(processQuestion(job, deps)).resolves.toEqual({ status: "provider_unavailable" });
      expect(deps.lineClient.reply).toHaveBeenCalledWith(
        job.replyToken,
        "目前回答服務有點忙，請稍後再 @我 試一次。",
      );
    },
  );

  it("throws when LINE delivery fails", async () => {
    const deps = dependencies();
    deps.lineClient.reply.mockRejectedValue(new LineReplyError(503));

    await expect(processQuestion(job, deps)).rejects.toBeInstanceOf(LineReplyError);
  });
});

describe("queue consumer", () => {
  function message(body: QuestionJob) {
    return { body, ack: vi.fn(), retry: vi.fn() };
  }

  function env(fetcher: ReturnType<typeof vi.fn>) {
    return {
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_MODEL: "model",
      LINE_CHANNEL_ACCESS_TOKEN: "line-key",
      FETCHER: fetcher,
    } as never;
  }

  it("acknowledges a successfully delivered provider fallback", async () => {
    const item = message(job);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await worker.queue({ messages: [item] } as never, env(fetcher), {} as never);

    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
  });

  it("retries only the message whose LINE delivery fails", async () => {
    const failed = message(job);
    const delivered = message({ ...job, webhookEventId: "event-2", replyToken: "reply-2" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "model", choices: [{ message: { content: "answer one" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "model", choices: [{ message: { content: "answer two" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await worker.queue({ messages: [failed, delivered] } as never, env(fetcher), {} as never);

    expect(failed.retry).toHaveBeenCalledOnce();
    expect(failed.ack).not.toHaveBeenCalled();
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(delivered.retry).not.toHaveBeenCalled();
  });
});
