import { describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";

import { createWorker } from "../src/index";
import type { Env } from "../src/config";
import type { QuestionJob } from "../src/jobs/types";
import type { TelemetryEvent } from "../src/telemetry/logger";

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

it("enables production logs and explicitly disables phase-one traces", () => {
  const config = unstable_readConfig(
    { config: "wrangler.jsonc" },
    { hideWarnings: true },
  );
  expect(config.observability).toEqual({
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1 },
    traces: { enabled: false },
  });
});

describe("createWorker repository injection", () => {
  it("uses injected knowledge-answering factories without production bindings", async () => {
    const repository = { claim: vi.fn().mockResolvedValue({ state: "claimed", leaseToken: "lease", leaseUntil: "2026-07-18T00:01:00.000Z", createdAt: job.receivedAt, expiresAt: "2026-08-18T00:00:00.000Z" }), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(), purgeExpired: vi.fn() };
    const evidence = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Answer.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "now", score: .9 } as const;
    const retriever = { retrieve: vi.fn().mockResolvedValue({ evidence: [evidence], insufficient: false, topScore: .9 }) };
    const webSearch = { search: vi.fn() }; const grounded = { answer: vi.fn().mockResolvedValue({ text: "Grounded", model: "m", citations: [], usedEvidenceIds: ["kb"] }) };
    const retrieverFactory = vi.fn(() => retriever), webFactory = vi.fn(() => webSearch), groundedFactory = vi.fn(() => grounded);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("api.line.me")
      ? new Response(null, { status: 200 })
      : Response.json({ model: "legacy", choices: [{ message: { content: "legacy" } }] }));
    const worker = createWorker({ questions: repository, retriever: retrieverFactory, webSearch: webFactory, groundedAnswerService: groundedFactory, fetcher });
    const message = { body: job, ack: vi.fn(), retry: vi.fn() }; const env = { ANALYTICS_HASH_KEY: "analytics-key-at-least-32-bytes", LINE_CHANNEL_ACCESS_TOKEN: "line", OPENROUTER_API_KEY: "key", OPENROUTER_MODEL: "model" } as Env;
    await worker.queue({ messages: [message] } as never, env, {} as ExecutionContext);
    expect(retrieverFactory).toHaveBeenCalledWith(env); expect(webFactory).toHaveBeenCalledWith(env); expect(groundedFactory).toHaveBeenCalledWith(env);
    expect(grounded.answer).toHaveBeenCalledWith(expect.objectContaining({ evidence: [evidence] })); expect(message.ack).toHaveBeenCalledOnce();
  });
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
    } as unknown as Env;

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

describe("grounded provider production wiring", () => {
  async function runGroundedQuestion(fallbackModel?: string) {
    const vectorId = "a".repeat(64);
    const evidenceId = `chunk:${vectorId}`;
    const repository = {
      claim: vi.fn().mockResolvedValue({
        state: "claimed",
        leaseToken: "lease-grounded",
        leaseUntil: "2026-07-18T00:01:00.000Z",
        createdAt: job.receivedAt,
        expiresAt: "2026-08-17T00:00:00.000Z",
      }),
      prepare: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      purgeExpired: vi.fn(),
    };
    const openRouterBodies: Array<{ model: string }> = [];
    const ai = {
      run: vi.fn(async (model: string) => {
        if (model === "@cf/baai/bge-m3") return { data: [Array(1024).fill(0)] };
        return {
          response: JSON.stringify({
            answer: "The event is open.",
            claims: [{ text: "The event is open.", evidenceIds: [evidenceId] }],
          }),
        };
      }),
    };
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({
            results: [{
              vectorId,
              chunkId: "chunk",
              documentId: "document",
              text: "The event is open.",
              displayName: "Guide",
              sourceUrl: null,
              pageNumber: 1,
              sectionPath: null,
              paragraphIndex: null,
              segmentIndex: 0,
            }],
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        })),
      })),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        openRouterBodies.push(JSON.parse(String(init?.body)) as { model: string });
        return new Response(null, { status: 500 });
      }
      if (url.includes("api.line.me")) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const env = {
      ANALYTICS_HASH_KEY: "analytics-key-at-least-32-bytes",
      LINE_CHANNEL_ACCESS_TOKEN: "line",
      OPENROUTER_API_KEY: "key",
      OPENROUTER_MODEL: "primary/model",
      OPENROUTER_FALLBACK_MODEL: fallbackModel,
      TAVILY_API_KEY: "tavily",
      AI: ai as unknown as Ai,
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({ matches: [{ id: vectorId, score: .9 }] }),
      } as unknown as VectorizeIndex,
      DB: db as unknown as D1Database,
    } as Env;
    const worker = createWorker({ questions: repository, fetcher });
    const message = { body: job, ack: vi.fn(), retry: vi.fn() };

    await worker.queue({ messages: [message] } as never, env, {} as ExecutionContext);

    return { ai, openRouterBodies, repository };
  }

  it("uses Workers AI when both configured OpenRouter models fail", async () => {
    const { ai, openRouterBodies, repository } = await runGroundedQuestion("fallback/model");

    expect(openRouterBodies.map((body) => body.model)).toEqual(["primary/model", "fallback/model"]);
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.2-3b-instruct",
      expect.objectContaining({ messages: expect.any(Array) }),
    );
    expect(repository.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ status: "answered", model: "@cf/meta/llama-3.2-3b-instruct" }),
      "answered",
      expect.any(String),
    );
  });

  it.each([undefined, "", "   ", "primary/model"])(
    "skips a missing, blank, or duplicate fallback model (%j)",
    async (fallbackModel) => {
      const { ai, openRouterBodies } = await runGroundedQuestion(fallbackModel);

      expect(openRouterBodies.map((body) => body.model)).toEqual(["primary/model"]);
      expect(ai.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3.2-3b-instruct",
        expect.objectContaining({ messages: expect.any(Array) }),
      );
    },
  );
});

describe("cron telemetry", () => {
  it("emits correlated cleanup started and completed events", async () => {
    const events: TelemetryEvent[] = [];
    let now = new Date("2026-07-18T12:34:56.000Z");
    const repository = {
      claim: vi.fn(), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(),
      purgeExpired: vi.fn().mockImplementation(async () => {
        now = new Date("2026-07-18T12:34:56.075Z");
        return 2;
      }),
    };
    const worker = createWorker({
      questions: repository,
      logger: { emit: (event) => events.push(event) },
      now: () => now,
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
      durationMs: 75,
    });
  });

  it("emits a failure classification then rethrows a stable sanitized error", async () => {
    const events: TelemetryEvent[] = [];
    let now = new Date("2026-07-18T12:34:56.000Z");
    const repository = {
      claim: vi.fn(), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(),
      purgeExpired: vi.fn().mockImplementation(async () => {
        now = new Date("2026-07-18T12:34:56.125Z");
        throw new Error("D1 unavailable: credentials=secret");
      }),
    };
    const worker = createWorker({
      questions: repository,
      logger: { emit: (event) => events.push(event) },
      now: () => now,
    });

    await expect(worker.scheduled({} as ScheduledController, {} as Env))
      .rejects.toThrow("scheduled cleanup failed");
    expect(events.at(-1)).toMatchObject({
      event: "cron.cleanup.failed",
      stage: "cron",
      outcome: "failed",
      errorType: "cron_cleanup_failed",
      durationMs: 125,
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
