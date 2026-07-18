import { describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/index";
import type { Env } from "../src/config";
import type { QuestionJob } from "../src/jobs/types";

const job: QuestionJob = {
  webhookEventId: "already-complete", replyToken: "reply", groupId: "group", userId: null,
  messageId: "message", text: "question", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z",
};

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
});
