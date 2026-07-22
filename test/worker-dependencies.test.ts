import { describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/index";
import type { Env } from "../src/config";
import type { QuestionJob } from "../src/jobs/types";

const job: QuestionJob = {
  webhookEventId: "already-complete", replyToken: "reply", groupId: "group", userId: null,
  messageId: "message", text: "question", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z",
};

describe("createWorker repository injection", () => {
  it("uses injected knowledge-answering factories without production bindings", async () => {
    const repository = { claim: vi.fn().mockResolvedValue({ state: "claimed", leaseToken: "lease", leaseUntil: "2026-07-18T00:01:00.000Z", createdAt: job.receivedAt, expiresAt: "2026-08-18T00:00:00.000Z" }), prepare: vi.fn(), complete: vi.fn(), release: vi.fn(), purgeExpired: vi.fn() };
    const evidence = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Answer.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "now", score: .9 } as const;
    const retriever = { retrieve: vi.fn().mockResolvedValue({ evidence: [evidence], insufficient: false, topScore: .9 }) };
    const webSearch = { search: vi.fn() }; const grounded = { answer: vi.fn().mockResolvedValue({ text: "Grounded", model: "m", citations: [], usedEvidenceIds: ["kb"] }) };
    const retrieverFactory = vi.fn(() => retriever), webFactory = vi.fn(() => webSearch), groundedFactory = vi.fn(() => grounded);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("api.line.me") ? new Response(null, { status: 200 }) : Response.json({ model: "legacy", choices: [{ message: { content: "legacy" } }] }));
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
});
