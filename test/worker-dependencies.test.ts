import { describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/index";
import type { Env } from "../src/config";
import type { QuestionJob } from "../src/jobs/types";
import type { TelemetryEvent } from "../src/telemetry/logger";
import wranglerConfig from "../wrangler.jsonc?raw";

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

it("enables production logs and sampled traces", () => {
  const config = JSON.parse(wranglerConfig);
  expect(config.observability).toEqual({
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1 },
    traces: { enabled: true, head_sampling_rate: 0.1 },
  });
});

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
    const answerService = {
      answer: vi.fn().mockResolvedValue({
        text: "fallback answer",
        model: "@cf/meta/llama-3.2-1b-instruct",
        inputTokens: null,
        outputTokens: null,
      }),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.line.me")) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const worker = createWorker({ questions: repository, fetcher, answerService });
    const env = {
      LINE_CHANNEL_SECRET: "secret",
      LINE_CHANNEL_ACCESS_TOKEN: "token",
      LINE_GROUP_ID: "group",
      ANALYTICS_HASH_KEY: "hash",
      GROUP_ADMINS_BOOTSTRAP_JSON: "[]",
      MESSAGE_QUEUE: { send: vi.fn() } as never,
      DB: {} as D1Database,
      AI: { run: vi.fn() } as never,
    } as Env;

    await worker.queue({ messages: [message] } as never, env, {} as ExecutionContext);

    expect(repository.claim).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(answerService.answer).toHaveBeenCalledOnce();
    const lineCall = fetcher.mock.calls.find(([calledInput]) => String(calledInput).includes("api.line.me"));
    expect(lineCall).toBeDefined();
    const lineBody = JSON.parse(String(lineCall?.[1]?.body));
    expect(lineBody.messages[0].text).toBe("fallback answer");
  });
});

describe("cron telemetry", () => {
  it("emits correlated cleanup started and completed events", async () => {
    const events: TelemetryEvent[] = [];
    const repository = {
      claim: vi.fn(), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(),
      purgeExpired: vi.fn().mockResolvedValue(2),
    };
    const worker = createWorker({
      questions: repository,
      logger: { emit: (event) => events.push(event) },
      now: () => new Date("2026-07-18T12:34:56.000Z"),
    });

    await worker.scheduled({} as ScheduledController, {} as Env);

    expect(events.map((event) => event.event)).toEqual([
      "cron.cleanup.started",
      "cron.cleanup.completed",
    ]);
    expect(events[0]?.operationId).toEqual(expect.any(String));
    expect(events[1]).toMatchObject({
      stage: "cron",
      outcome: "success",
      operationId: events[0]?.operationId,
    });
  });

  it("emits a failure classification then rethrows a stable sanitized error", async () => {
    const events: TelemetryEvent[] = [];
    const repository = {
      claim: vi.fn(), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(),
      purgeExpired: vi.fn().mockRejectedValue(new Error("D1 unavailable: credentials=secret")),
    };
    const worker = createWorker({
      questions: repository,
      logger: { emit: (event) => events.push(event) },
    });

    await expect(worker.scheduled({} as ScheduledController, {} as Env))
      .rejects.toThrow("scheduled cleanup failed");
    expect(events.at(-1)).toMatchObject({
      event: "cron.cleanup.failed",
      stage: "cron",
      outcome: "failed",
      errorType: "cron_cleanup_failed",
    });
    expect(JSON.stringify(events)).not.toContain("credentials=secret");
  });
});

describe("queue boundary telemetry", () => {
  it("classifies an unexpected processing exception before retrying the message", async () => {
    const events: TelemetryEvent[] = [];
    const malformedJob = { ...job, text: Symbol("queue boundary secret") } as unknown as QuestionJob;
    const message = { body: malformedJob, ack: vi.fn(), retry: vi.fn() };
    const worker = createWorker({
      logger: { emit: (event) => events.push(event) },
    });

    await worker.queue({ messages: [message] } as never, {} as Env, {} as ExecutionContext);

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(events.at(-1)).toMatchObject({
      event: "queue.message.retry",
      stage: "queue",
      outcome: "retry",
      webhookEventId: malformedJob.webhookEventId,
      retryDelaySeconds: 1,
      errorType: "unexpected_error",
    });
    expect(JSON.stringify(events)).not.toContain("queue boundary secret");
  });
});
