import { describe, expect, it, vi } from "vitest";
import type { QuestionJob } from "../src/jobs/types";
import { processQuestion } from "../src/jobs/process-message";
import worker from "../src/index";
import { LineReplyError } from "../src/line/client";
import type { TelemetryEvent, TelemetryLogger } from "../src/telemetry/logger";
import { AnswerUnavailableError } from "../src/answers/openrouter";
const job: QuestionJob = { webhookEventId: "event-1", replyToken: "reply-1", groupId: "group-1", userId: "user-1", messageId: "message-1", text: "Where should I run?", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z" };
const claimed = { state: "claimed", leaseToken: "lease-a", leaseUntil: "2026-07-18T00:01:00.000Z", createdAt: job.receivedAt, expiresAt: "2026-08-17T00:00:00.000Z" };
function deps(claim: unknown = claimed) { return { now: () => new Date("2026-07-18T00:00:00.000Z"), answerService: { answer: vi.fn().mockResolvedValue({ text: "Try the riverside.", model: "model" }) }, lineClient: { reply: vi.fn().mockResolvedValue(undefined), push: vi.fn().mockResolvedValue(undefined) }, questions: { claim: vi.fn().mockResolvedValue(claim), prepare: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) }, pseudonymize: vi.fn().mockResolvedValue("user-key") }; }
describe("processQuestion", () => {
  it("emits the successful processing sequence", async () => {
    const events: TelemetryEvent[] = [];
    const logger: TelemetryLogger = { emit: (event) => events.push(event) };
    const d = { ...deps(), logger };

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "answer.completed",
      "line.reply.completed",
      "question.completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      stage: "queue",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: "general",
    });
  });
  it("emits classified claim failure retry events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.questions.claim.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      errorType: "lease_unavailable",
      retryDelaySeconds: 1,
    });
  });
  it("emits classified busy claim retry events", async () => {
    const events: TelemetryEvent[] = [];
    const d = {
      ...deps({ state: "busy", leaseUntil: "2026-07-18T00:00:45.000Z" }),
      logger: { emit: (event: TelemetryEvent) => events.push(event) },
    };

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 45 });

    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      errorType: "lease_unavailable",
      retryDelaySeconds: 45,
    });
  });
  it("emits classified answer failure events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.answerService.answer.mockRejectedValueOnce(new AnswerUnavailableError("rate_limited"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "provider_unavailable" });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "answer.failed",
        stage: "answer",
        outcome: "fallback",
        errorType: "ai_rate_limited",
      }),
    ]));
  });
  it("emits classified prepare failure retry events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.questions.prepare.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      errorType: "storage_unavailable",
      retryDelaySeconds: 1,
    });
  });
  it("emits classified LINE reply fallback events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "line.reply.failed",
        stage: "line",
        outcome: "fallback",
        errorType: "line_reply_failed",
      }),
      expect.objectContaining({
        event: "line.push.completed",
        stage: "line",
        outcome: "success",
      }),
    ]));
  });
  it("emits classified LINE delivery failure events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503));
    d.lineClient.push.mockRejectedValueOnce(new Error("push unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "line.push.failed",
        errorType: "line_push_failed",
        outcome: "failed",
      }),
    ]));
  });
  it("emits classified completion failure retry events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.questions.complete.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      errorType: "storage_unavailable",
      retryDelaySeconds: 1,
    });
  });
  it("preserves processing results when telemetry emission throws", async () => {
    const d = { ...deps(), logger: { emit: () => { throw new Error("telemetry unavailable"); } } };

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" });
  });
  it("emits a retry event when pseudonymization fails", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.pseudonymize.mockRejectedValueOnce(new Error("pseudonymization unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "queue",
      outcome: "retry",
      errorType: "unexpected_error",
      retryDelaySeconds: 1,
    });
  });
  it("emits a retry event when LINE reply cannot fall back", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.lineClient.reply.mockRejectedValueOnce(new Error("reply unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "line.reply.failed",
        stage: "line",
        outcome: "retry",
        errorType: "line_reply_failed",
      }),
      expect.objectContaining({
        event: "question.retry",
        stage: "line",
        outcome: "retry",
        errorType: "line_reply_failed",
        retryDelaySeconds: 1,
      }),
    ]));
  });
  it("claims with a 60-second lease and prepares before LINE delivery", async () => { const d = deps(); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.questions.claim).toHaveBeenCalledWith("event-1", "2026-07-18T00:01:00.000Z", job.receivedAt); expect(d.questions.prepare).toHaveBeenCalledWith(expect.anything(), "answered", "lease-a"); expect(d.questions.prepare.mock.invocationCallOrder[0]!).toBeLessThan(d.lineClient.reply.mock.invocationCallOrder[0]!); });
  it("routes weather questions to the weather service and records a metric", async () => {
    const metrics = { record: vi.fn().mockResolvedValue(undefined) };
    const weatherService = { answer: vi.fn().mockResolvedValue({ text: "台北現在 31°C，局部多雲。", model: "open-meteo" }) };
    const d = { ...deps(), weatherService, metrics };
    const weatherJob = { ...job, text: "今天台北天氣如何？" };

    await expect(processQuestion(weatherJob, d)).resolves.toEqual({ disposition: "ack", status: "answered" });
    expect(weatherService.answer).toHaveBeenCalledOnce();
    expect(d.answerService.answer).not.toHaveBeenCalled();
    expect(d.lineClient.reply).toHaveBeenCalledWith(weatherJob.replyToken, "台北現在 31°C，局部多雲。");
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({ intent: "weather", status: "answered", model: "open-meteo" }));
  });
  it("returns a bounded delayed retry for a concurrent busy claim", async () => { const d = deps({ state: "busy", leaseUntil: "2026-07-18T00:00:45.000Z" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 45 }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("acks a completed duplicate without LLM or LINE calls", async () => { const d = deps({ state: "completed" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("resumes expired prepared work without calling the LLM", async () => { const d = deps({ ...claimed, leaseToken: "lease-b", prepared: { text: "saved", model: "saved-model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).toHaveBeenCalledWith("reply-1", "saved"); });
  it("does not call LINE when a stale worker loses its fenced prepare", async () => { const d = deps(); d.questions.prepare.mockRejectedValue(new Error("stale claim")); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.lineClient.reply).not.toHaveBeenCalled(); expect(d.questions.release).toHaveBeenCalledWith("event-1", "lease-a"); });
  it("falls back to pushing the group when LINE reply fails", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.lineClient.push).toHaveBeenCalledWith(job.groupId, "Try the riverside."); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "answered", answer: "Try the riverside." }), "lease-a"); expect(d.answerService.answer).toHaveBeenCalledOnce(); });
  it("records reply_failed and retries when both reply and push fail", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503)); d.lineClient.push.mockRejectedValueOnce(new Error("push down")); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "reply_failed", answer: "Try the riverside." }), "lease-a"); d.questions.claim.mockResolvedValueOnce({ ...claimed, leaseToken: "lease-b", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); expect(d.lineClient.reply).toHaveBeenNthCalledWith(2, job.replyToken, "Try the riverside."); });
  it("reuses the stable replyToken and prepared text after LINE success but completion failure", async () => { const d = deps(); d.questions.complete.mockRejectedValueOnce(new Error("db failed")).mockResolvedValueOnce(undefined); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); d.questions.claim.mockResolvedValueOnce({ ...claimed, leaseToken: "lease-b", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); expect(d.lineClient.reply).toHaveBeenNthCalledWith(1, job.replyToken, "Try the riverside."); expect(d.lineClient.push).toHaveBeenCalledWith(job.groupId, "Try the riverside."); });
});

describe("queue consumer", () => {
  it("acks completed messages and retries busy messages independently", async () => {
    const db = { prepare: (_sql: string) => ({ bind: (id: string) => ({ run: async () => ({ meta: { changes: 0 } }), first: async () => ({ status: id === "done" ? "answered" : "processing", lease_until: new Date(Date.now() + 60_000).toISOString() }) }) }) };
    const completed = { body: { ...job, webhookEventId: "done" }, ack: vi.fn(), retry: vi.fn() };
    const busy = { body: { ...job, webhookEventId: "busy" }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [completed, busy] } as never, { DB: db } as never, {} as never);
    expect(completed.ack).toHaveBeenCalledOnce(); expect(completed.retry).not.toHaveBeenCalled();
    expect(busy.retry).toHaveBeenCalledOnce(); const delay = busy.retry.mock.calls[0]![0].delaySeconds; expect(delay).toBeGreaterThanOrEqual(59); expect(delay).toBeLessThanOrEqual(60); expect(busy.ack).not.toHaveBeenCalled();
  });
});
