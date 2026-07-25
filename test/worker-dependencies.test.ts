import { describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/index";
import type { Env } from "../src/config";
import type { QuestionJob } from "../src/jobs/types";

const job: QuestionJob = {
  webhookEventId: "already-complete", replyToken: "reply", groupId: "group", userId: null,
  messageId: "message", text: "question", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createWorker repository injection", () => {
  it("uses the injected repository in the queue consumer", async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue({ state: "completed" }),
      prepare: vi.fn(), complete: vi.fn(), release: vi.fn(), purgeExpired: vi.fn(),
    };
    const message = { body: job, ack: vi.fn(), retry: vi.fn() };
    const worker = createWorker({ questions: repository });
    await worker.queue({ messages: [message] } as never, {} as Env, {} as ExecutionContext);
    expect(repository.claim).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("uses an injected repository factory for scheduled purge", async () => {
    const repository = {
      claim: vi.fn(), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(),
      purgeExpired: vi.fn().mockResolvedValue(2),
    };
    const factory = vi.fn(() => repository);
    const worker = createWorker({ questions: factory, now: () => new Date("2026-07-18T12:34:56.000Z") });
    const env = {} as Env;
    await worker.scheduled({} as ScheduledController, env);
    expect(factory).toHaveBeenCalledWith(env);
    expect(repository.purgeExpired).toHaveBeenCalledWith("2026-07-18T12:34:56.000Z");
  });

  it("passes the fallback model through to the queue consumer answer service", async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue({
        state: "claimed",
        leaseToken: "lease-a",
        leaseUntil: "2026-07-18T00:01:00.000Z",
        createdAt: job.receivedAt,
        expiresAt: "2026-08-17T00:00:00.000Z",
      }),
      prepare: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      purgeExpired: vi.fn(),
    };
    const message = { body: job, ack: vi.fn(), retry: vi.fn() };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        return fetcher.mock.calls.filter(([calledInput]) => String(calledInput).includes("openrouter.ai")).length === 1
          ? new Response("bad", { status: 503 })
          : jsonResponse({
              model: "fallback/model",
              choices: [{ message: { content: "  fallback answer  " } }],
            });
      }
      if (url.includes("api.line.me")) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const worker = createWorker({ questions: repository, fetcher });
    const env = {
      LINE_CHANNEL_SECRET: "secret",
      LINE_CHANNEL_ACCESS_TOKEN: "token",
      LINE_GROUP_ID: "group",
      OPENROUTER_API_KEY: "key",
      OPENROUTER_MODEL: "primary/model",
      OPENROUTER_FALLBACK_MODEL: "fallback/model",
      ANALYTICS_HASH_KEY: "hash",
      GROUP_ADMINS_BOOTSTRAP_JSON: "[]",
      MESSAGE_QUEUE: { send: vi.fn() } as never,
      DB: {} as D1Database,
    } as Env;

    await worker.queue({ messages: [message] } as never, env, {} as ExecutionContext);

    expect(repository.claim).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    const lineCall = fetcher.mock.calls.find(([calledInput]) => String(calledInput).includes("api.line.me"));
    expect(lineCall).toBeDefined();
    const lineBody = JSON.parse(String(lineCall?.[1]?.body));
    expect(lineBody.messages[0].text).toBe("fallback answer");
  });
});
