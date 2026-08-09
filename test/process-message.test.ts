import { describe, expect, it, vi } from "vitest";
import type { QuestionJob } from "../src/jobs/types";
import { processQuestion } from "../src/jobs/process-message";
import worker from "../src/index";
import { LineReplyError } from "../src/line/client";
import { createConsoleTelemetryLogger, type TelemetryEvent, type TelemetryLogger } from "../src/telemetry/logger";
import { AnswerUnavailableError, WorkersAiAnswerService } from "../src/answers/openrouter";
import type { AnswerProviderObserver } from "../src/answers/types";
const job: QuestionJob = { webhookEventId: "event-1", replyToken: "reply-1", groupId: "group-1", userId: "user-1", messageId: "message-1", text: "Where should I run?", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z" };
const claimed = { state: "claimed", leaseToken: "lease-a", leaseUntil: "2026-07-18T00:01:00.000Z", createdAt: job.receivedAt, expiresAt: "2026-08-17T00:00:00.000Z" };
function deps(claim: unknown = claimed) { return { now: () => new Date("2026-07-18T00:00:00.000Z"), answerService: { answer: vi.fn().mockResolvedValue({ text: "Try the riverside.", model: "model" }) }, lineClient: { reply: vi.fn().mockResolvedValue(undefined), push: vi.fn().mockResolvedValue(undefined) }, questions: { claim: vi.fn().mockResolvedValue(claim), prepare: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) }, pseudonymize: vi.fn().mockResolvedValue("user-key") }; }
function observed<T extends object = ReturnType<typeof deps>>(base: T = deps() as T) {
  const events: TelemetryEvent[] = [];
  return {
    events,
    dependencies: {
      ...base,
      logger: { emit: (event: TelemetryEvent) => events.push(event) },
    },
  };
}
describe("processQuestion", () => {
  it("emits the successful processing sequence", async () => {
    const events: TelemetryEvent[] = [];
    const logger: TelemetryLogger = { emit: (event) => events.push(event) };
    const d = { ...deps(), logger };

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "answer.completed",
      "storage.prepare.completed",
      "line.reply.completed",
      "storage.complete.completed",
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
    d.questions.claim.mockRejectedValueOnce(new Error("database unavailable secret"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.failed",
      "question.retry",
    ]);
    expect(events.at(-2)).toMatchObject({
      stage: "storage",
      outcome: "failed",
      errorType: "lease_unavailable",
    });
    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      errorType: "lease_unavailable",
      retryDelaySeconds: 1,
    });
    expect(JSON.stringify(events)).not.toContain("database unavailable secret");
  });
  it("emits classified busy claim retry events", async () => {
    const events: TelemetryEvent[] = [];
    const d = {
      ...deps({ state: "busy", leaseUntil: "2026-07-18T00:00:45.000Z" }),
      logger: { emit: (event: TelemetryEvent) => events.push(event) },
    };

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 45 });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "question.retry",
    ]);
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
    d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400));

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
    d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400));
    d.lineClient.push.mockRejectedValueOnce(new Error("push unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "line.push.failed",
        errorType: "line_push_failed",
        outcome: "failed",
      }),
    ]));
    expect(events.at(-1)).toMatchObject({
      event: "question.retry",
      stage: "queue",
      outcome: "retry",
      errorType: "line_push_failed",
      retryDelaySeconds: 1,
    });
  });
  it("emits classified completion failure retry events", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.questions.complete.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(events.at(-2)).toMatchObject({
      event: "storage.complete.failed",
      stage: "storage",
      outcome: "failed",
      errorType: "storage_unavailable",
    });
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
  it("preserves an ack when the telemetry clock fails after processing starts", async () => {
    let reads = 0;
    const d = {
      ...deps(),
      logger: { emit: () => undefined },
      now: () => {
        reads += 1;
        if (reads >= 5) throw new Error("telemetry clock unavailable");
        return new Date("2026-07-18T00:00:00.000Z");
      },
    };

    await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" });
  });
  it("does not write raw LINE push errors to the console", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const d = deps();
    d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400));
    d.lineClient.push.mockRejectedValueOnce(new Error("sensitive push failure"));

    try {
      await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
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

  it("records ordered storage successes and provider duration", async () => {
    let current = new Date("2026-07-18T00:00:00.000Z");
    const base = deps();
    base.now = () => current;
    base.answerService.answer.mockImplementationOnce(async () => {
      current = new Date("2026-07-18T00:00:00.040Z");
      return { text: "safe answer", model: "model" };
    });
    const { dependencies, events } = observed(base);

    await expect(processQuestion(job, dependencies)).resolves.toEqual({
      disposition: "ack",
      status: "answered",
    });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "answer.completed",
      "storage.prepare.completed",
      "line.reply.completed",
      "storage.complete.completed",
      "question.completed",
    ]);
    expect(events.find((event) => event.event === "answer.completed")).toMatchObject({
      durationMs: 40,
      webhookEventId: job.webhookEventId,
    });
  });

  it("emits the exact AI primary-to-fallback sequence and safe reason", async () => {
    let current = new Date("2026-07-18T00:00:00.000Z");
    const ai = {
      run: vi
        .fn()
        .mockImplementationOnce(async () => {
          current = new Date("2026-07-18T00:00:00.010Z");
          throw Object.assign(new Error("provider body is private"), { status: 429 });
        })
        .mockImplementationOnce(async () => {
          current = new Date("2026-07-18T00:00:00.030Z");
          return { response: "safe fallback" };
        }),
    };
    const events: TelemetryEvent[] = [];
    const dependencies = {
      ...deps(),
      now: () => current,
      answerService: new WorkersAiAnswerService(
        ai as never,
        "primary-model",
        "fallback-model",
        () => current.getTime(),
      ),
      logger: { emit: (event: TelemetryEvent) => events.push(event) },
    };

    await expect(processQuestion(job, dependencies)).resolves.toEqual({
      disposition: "ack",
      status: "answered",
    });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "answer.ai.attempt.started",
      "answer.ai.attempt.failed",
      "answer.ai.fallback.started",
      "answer.ai.attempt.started",
      "answer.ai.attempt.completed",
      "answer.completed",
      "storage.prepare.completed",
      "line.reply.completed",
      "storage.complete.completed",
      "question.completed",
    ]);
    expect(events[3]).toMatchObject({
      outcome: "failed",
      detail: "primary_model",
      model: "primary-model",
      errorType: "ai_rate_limited",
      durationMs: 10,
    });
    expect(events[4]).toMatchObject({
      outcome: "fallback",
      detail: "fallback_model",
      model: "fallback-model",
      errorType: "ai_rate_limited",
    });
    expect(events[6]).toMatchObject({
      outcome: "success",
      detail: "fallback_model",
      model: "fallback-model",
      durationMs: 20,
    });
    expect(events[7]).toMatchObject({
      model: "fallback-model",
      durationMs: 30,
    });
    expect(JSON.stringify(events)).not.toContain("provider body is private");
  });

  it("ends a prepare and release failure path with one classified retry", async () => {
    const { dependencies, events } = observed();
    dependencies.questions.prepare.mockRejectedValueOnce(new Error("prepare secret"));
    dependencies.questions.release.mockRejectedValueOnce(new Error("release secret"));

    await expect(processQuestion(job, dependencies)).resolves.toEqual({
      disposition: "retry",
      delaySeconds: 1,
    });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "answer.completed",
      "storage.prepare.failed",
      "storage.release.failed",
      "question.retry",
    ]);
    expect(events.at(-2)).toMatchObject({
      stage: "storage",
      outcome: "failed",
      errorType: "storage_unavailable",
    });
    expect(events.at(-1)).toMatchObject({
      outcome: "retry",
      retryDelaySeconds: 1,
      errorType: "storage_unavailable",
    });
    expect(JSON.stringify(events)).not.toContain("prepare secret");
    expect(JSON.stringify(events)).not.toContain("release secret");
  });

  it("classifies a weather settings storage failure before retrying", async () => {
    const { dependencies, events } = observed({
      ...deps(),
      weatherService: {
        answer: vi.fn().mockResolvedValue({ text: "safe weather", model: "open-meteo" }),
      },
      groupSettings: {
        getWeatherCity: vi.fn().mockRejectedValue(new Error("settings database secret")),
      },
    });
    const weatherJob = { ...job, text: "Taipei weather" };

    await expect(processQuestion(weatherJob, dependencies)).resolves.toEqual({
      disposition: "retry",
      delaySeconds: 1,
    });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "weather.settings.failed",
      "question.retry",
    ]);
    expect(events.at(-2)).toMatchObject({
      stage: "storage",
      outcome: "failed",
      errorType: "storage_unavailable",
      detail: "weather_settings",
    });
    expect(JSON.stringify(events)).not.toContain("settings database secret");
  });

  it.each([
    ["weather_timeout", () => new DOMException("private timeout", "AbortError")],
    ["weather_provider_error", () => new Error("private provider response")],
  ] as const)("classifies %s separately from storage failures", async (errorType, makeError) => {
    let current = new Date("2026-07-18T00:00:00.000Z");
    const { dependencies, events } = observed({
      ...deps(),
      now: () => current,
      weatherService: {
        answer: vi.fn().mockImplementationOnce(async () => {
          current = new Date("2026-07-18T00:00:00.025Z");
          throw makeError();
        }),
      },
    });
    const weatherJob = { ...job, text: "Taipei weather" };

    await expect(processQuestion(weatherJob, dependencies)).resolves.toEqual({
      disposition: "ack",
      status: "provider_unavailable",
    });

    expect(events.find((event) => event.event === "answer.failed")).toMatchObject({
      stage: "answer",
      outcome: "fallback",
      errorType,
      durationMs: 25,
    });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it.each([
    ["cache_read", "weather_cache_read"],
    ["cache_write", "weather_cache_write"],
  ] as const)("keeps weather %s failures best-effort and returns the valid answer", async (operation, detail) => {
    const { dependencies, events } = observed({
      ...deps(),
      weatherService: {
        answer: vi.fn().mockImplementation(async (_request, observe?: AnswerProviderObserver) => {
          observe?.({ type: "storage.failed", provider: "open_meteo", operation });
          return {
            text: "valid weather answer",
            model: "open-meteo",
            inputTokens: null,
            outputTokens: null,
          };
        }),
      },
    });
    const weatherJob = { ...job, text: "Taipei weather" };

    await expect(processQuestion(weatherJob, dependencies)).resolves.toEqual({
      disposition: "ack",
      status: "answered",
    });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "weather.cache.failed",
      "answer.completed",
      "storage.prepare.completed",
      "line.reply.completed",
      "storage.complete.completed",
      "question.completed",
    ]);
    expect(events[2]).toMatchObject({
      stage: "storage",
      outcome: "failed",
      errorType: "storage_unavailable",
      detail,
    });
    expect(dependencies.lineClient.reply).toHaveBeenCalledWith(
      weatherJob.replyToken,
      "valid weather answer",
    );
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "answer.failed" }),
      expect.objectContaining({ event: "question.retry" }),
      expect.objectContaining({ errorType: "weather_provider_error" }),
    ]));
  });

  it("emits prepared-answer reuse instead of another provider terminal event", async () => {
    const { dependencies, events } = observed(deps({
      ...claimed,
      leaseToken: "lease-b",
      prepared: { text: "saved", model: "saved-model", status: "answered" },
    }));

    await expect(processQuestion(job, dependencies)).resolves.toEqual({
      disposition: "ack",
      status: "answered",
    });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "answer.prepared.reused",
      "line.reply.completed",
      "storage.complete.completed",
      "question.completed",
    ]);
    expect(events[2]).toMatchObject({ detail: "reused_prepared" });
  });

  it("emits a dedicated completed-duplicate outcome without inventing stored status", async () => {
    const { dependencies, events } = observed(deps({ state: "completed" }));

    await expect(processQuestion(job, dependencies)).resolves.toEqual({ disposition: "ack" });

    expect(events.map((event) => event.event)).toEqual([
      "question.started",
      "storage.claim.completed",
      "question.deduplicated",
    ]);
    expect(events.at(-1)).toMatchObject({
      stage: "queue",
      outcome: "success",
      webhookEventId: job.webhookEventId,
    });
  });
  it("claims with a 60-second lease and prepares before LINE delivery", async () => { const d = deps(); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.questions.claim).toHaveBeenCalledWith("event-1", "2026-07-18T00:01:00.000Z", job.receivedAt); expect(d.questions.prepare).toHaveBeenCalledWith(expect.anything(), "answered", "lease-a"); expect(d.questions.prepare.mock.invocationCallOrder[0]!).toBeLessThan(d.lineClient.reply.mock.invocationCallOrder[0]!); });
  it("routes weather questions to the weather service and records a metric", async () => {
    const metrics = { record: vi.fn().mockResolvedValue(undefined) };
    const weatherService = { answer: vi.fn().mockResolvedValue({ text: "台北現在 31°C，局部多雲。", model: "open-meteo" }) };
    const retriever = { retrieve: vi.fn() }, webSearch = { search: vi.fn() }, groundedAnswerService = { answer: vi.fn() };
    const d = { ...deps(), weatherService, metrics, retriever, webSearch, groundedAnswerService };
    const weatherJob = { ...job, text: "請問斗六市明天適合跑步嗎？" };

    await expect(processQuestion(weatherJob, d)).resolves.toEqual({ disposition: "ack", status: "answered" });
    expect(weatherService.answer).toHaveBeenCalledOnce();
    expect(d.answerService.answer).not.toHaveBeenCalled();
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(webSearch.search).not.toHaveBeenCalled();
    expect(groundedAnswerService.answer).not.toHaveBeenCalled();
    expect(d.lineClient.reply).toHaveBeenCalledWith(weatherJob.replyToken, "台北現在 31°C，局部多雲。");
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({ intent: "weather", status: "answered", model: "open-meteo" }));
  });
  it("returns a bounded delayed retry for a concurrent busy claim", async () => { const d = deps({ state: "busy", leaseUntil: "2026-07-18T00:00:45.000Z" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 45 }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("acks a completed duplicate without LLM or LINE calls", async () => { const d = deps({ state: "completed" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("resumes expired prepared work without calling the LLM", async () => { const d = deps({ ...claimed, leaseToken: "lease-b", prepared: { text: "saved", model: "saved-model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).toHaveBeenCalledWith("reply-1", "saved"); });
  it("does not call LINE when a stale worker loses its fenced prepare", async () => { const d = deps(); d.questions.prepare.mockRejectedValue(new Error("stale claim")); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.lineClient.reply).not.toHaveBeenCalled(); expect(d.questions.release).toHaveBeenCalledWith("event-1", "lease-a"); });
  it("falls back to pushing the group when LINE rejects an expired reply token", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.lineClient.push).toHaveBeenCalledWith(job.groupId, "Try the riverside."); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "answered", answer: "Try the riverside." }), "lease-a"); expect(d.answerService.answer).toHaveBeenCalledOnce(); });
  it("does not push after an uncertain LINE reply failure", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.lineClient.push).not.toHaveBeenCalled(); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "reply_failed" }), "lease-a"); });
  it("does not log provider error payloads", async () => { const d = deps(); const info = vi.spyOn(console, "info").mockImplementation(() => undefined); d.answerService.answer.mockRejectedValueOnce(new Error("sensitive-provider-payload")); await processQuestion(job, d); expect(JSON.stringify(info.mock.calls)).not.toContain("sensitive-provider-payload"); info.mockRestore(); });
  it("records reply_failed and retries when both reply and push fail", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400)); d.lineClient.push.mockRejectedValueOnce(new Error("push down")); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "reply_failed", answer: "Try the riverside." }), "lease-a"); d.questions.claim.mockResolvedValueOnce({ ...claimed, leaseToken: "lease-b", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); expect(d.lineClient.reply).toHaveBeenNthCalledWith(2, job.replyToken, "Try the riverside."); });
  it("reuses the stable replyToken and prepared text after LINE success but completion failure", async () => { const d = deps(); d.questions.complete.mockRejectedValueOnce(new Error("db failed")).mockResolvedValueOnce(undefined); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); d.questions.claim.mockResolvedValueOnce({ ...claimed, leaseToken: "lease-b", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); expect(d.lineClient.reply).toHaveBeenNthCalledWith(1, job.replyToken, "Try the riverside."); expect(d.lineClient.push).toHaveBeenCalledWith(job.groupId, "Try the riverside."); });

  it("retrieves, routes, searches, then grounds before preparing", async () => {
    const d = deps(); const kb = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Run at six.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "now", score: .9 } as const;
    const web = { ...kb, id: "web:1", sourceType: "web", url: "https://example.com" } as const;
    const retriever = { retrieve: vi.fn().mockResolvedValue({ evidence: [kb], insufficient: false, topScore: .9 }) };
    const webSearch = { search: vi.fn().mockResolvedValue([web]) }; const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "Grounded", model: "grounded-model", citations: [], usedEvidenceIds: ["kb"], validatedClaims: [] }) };
    await processQuestion({ ...job, text: "search online for run time" }, { ...d, retriever, webSearch, groundedAnswerService });
    expect(retriever.retrieve).toHaveBeenCalledWith("search online for run time", 8); expect(webSearch.search).toHaveBeenCalledWith("search online for run time");
    expect(groundedAnswerService.answer).toHaveBeenCalledWith({ question: "search online for run time", evidence: [kb, web], webUnavailable: false });
    expect(retriever.retrieve.mock.invocationCallOrder[0]!).toBeLessThan(webSearch.search.mock.invocationCallOrder[0]!);
    expect(webSearch.search.mock.invocationCallOrder[0]!).toBeLessThan(groundedAnswerService.answer.mock.invocationCallOrder[0]!);
    expect(d.questions.prepare).toHaveBeenCalledWith(expect.objectContaining({ answer: "Grounded", model: "grounded-model" }), "answered", "lease-a");
  });

  it("degrades web failure to KB evidence and marks web unavailable", async () => {
    const d = deps(); const kb = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Run at six.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "now", score: .9 } as const;
    const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "KB answer", model: "m", citations: [], usedEvidenceIds: ["kb"], validatedClaims: [] }) };
    await processQuestion({ ...job, text: "search online for run time" }, { ...d, retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [kb], insufficient: false, topScore: .9 }) }, webSearch: { search: vi.fn().mockRejectedValue(new Error("down")) }, groundedAnswerService });
    expect(groundedAnswerService.answer).toHaveBeenCalledWith(expect.objectContaining({ evidence: [kb], webUnavailable: true }));
  });

  it("returns insufficient evidence for factual questions but permits clearly casual conversation", async () => {
    const factual = deps(), casual = deps(); const empty = { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) }; const webDown = { search: vi.fn().mockRejectedValue(new Error("down")) };
    await processQuestion({ ...job, text: "What time does the race start?" }, { ...factual, retriever: empty, webSearch: webDown, groundedAnswerService: { answer: vi.fn() } });
    expect(factual.answerService.answer).not.toHaveBeenCalled(); expect(factual.lineClient.reply).toHaveBeenCalledWith(job.replyToken, expect.stringContaining("enough reliable evidence"));
    await processQuestion({ ...job, text: "hello!" }, { ...casual, retriever: empty, webSearch: webDown, groundedAnswerService: { answer: vi.fn() } });
    expect(casual.answerService.answer).toHaveBeenCalledOnce();
  });

  it("prepared duplicate bypasses retrieval, web search, and grounded generation", async () => {
    const d = deps({ ...claimed, prepared: { text: "saved", model: "saved-model", status: "answered" } }); const retriever = { retrieve: vi.fn() }, webSearch = { search: vi.fn() }, groundedAnswerService = { answer: vi.fn() };
    await processQuestion(job, { ...d, retriever, webSearch, groundedAnswerService });
    expect(retriever.retrieve).not.toHaveBeenCalled(); expect(webSearch.search).not.toHaveBeenCalled(); expect(groundedAnswerService.answer).not.toHaveBeenCalled();
  });

  it("creates a review-only draft from a newly grounded web answer without question identity fields", async () => {
    const d = deps();
    const web = { id: "web:run", sourceType: "web", title: "Official run guide", url: "https://example.gov/run", text: "The route opens at six.", pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-18T00:00:00.000Z", score: .9 } as const;
    const discarded = { ...web, id: "web:discarded", title: "Discarded source title", url: "https://discarded.example/run", text: "Discarded source text." } as const;
    const knowledgeDrafts = { createOrRefresh: vi.fn().mockResolvedValue(undefined) };
    const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "The route opens at six.", model: "grounded-model", citations: [], usedEvidenceIds: [web.id], validatedClaims: [{ text: "The route opens at six.", evidenceIds: [web.id] }] }) };

    await expect(processQuestion({ ...job, text: "search online for run time" }, {
      ...d,
      retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) },
      webSearch: { search: vi.fn().mockResolvedValue([web, discarded]) },
      groundedAnswerService,
      knowledgeDrafts,
    })).resolves.toEqual({ disposition: "ack", status: "answered" });

    expect(knowledgeDrafts.createOrRefresh).toHaveBeenCalledOnce();
    expect(knowledgeDrafts.createOrRefresh).toHaveBeenCalledWith(expect.objectContaining({
      topic: "The route opens at six.",
      sources: [expect.objectContaining({ url: "https://example.gov/run" })],
    }));
    expect(d.questions.prepare.mock.invocationCallOrder[0]!).toBeLessThan(
      knowledgeDrafts.createOrRefresh.mock.invocationCallOrder[0]!,
    );
    const draft = knowledgeDrafts.createOrRefresh.mock.calls[0]![0] as Record<string, unknown>;
    expect(draft).not.toHaveProperty("groupId"); expect(draft).not.toHaveProperty("userId"); expect(draft).not.toHaveProperty("userKey"); expect(draft).not.toHaveProperty("replyToken"); expect(draft).not.toHaveProperty("question");
    expect(draft.markdown).not.toContain("search online for run time");
    expect(JSON.stringify(draft)).not.toContain(discarded.title);
    expect(JSON.stringify(draft)).not.toContain(discarded.url);
    expect(JSON.stringify(draft)).not.toContain(discarded.text);
  });

  it("keeps LINE delivery and completion successful when draft storage fails", async () => {
    const d = deps(); const events: TelemetryEvent[] = [];
    const web = { id: "web:run", sourceType: "web", title: "Official run guide", url: "https://example.gov/run", text: "The route opens at six.", pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-18T00:00:00.000Z", score: .9 } as const;
    const knowledgeDrafts = { createOrRefresh: vi.fn().mockRejectedValue(new Error("D1 draft secret")) };
    const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "The route opens at six.", model: "grounded-model", citations: [], usedEvidenceIds: [web.id], validatedClaims: [{ text: "The route opens at six.", evidenceIds: [web.id] }] }) };

    await expect(processQuestion({ ...job, text: "search online for run time" }, {
      ...d, logger: createConsoleTelemetryLogger((event) => events.push(event)),
      retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) }, webSearch: { search: vi.fn().mockResolvedValue([web]) }, groundedAnswerService, knowledgeDrafts,
    })).resolves.toEqual({ disposition: "ack", status: "answered" });

    expect(d.lineClient.reply).toHaveBeenCalledWith(job.replyToken, "The route opens at six.");
    expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "answered" }), "lease-a");
    expect(d.questions.prepare.mock.invocationCallOrder[0]!).toBeLessThan(
      knowledgeDrafts.createOrRefresh.mock.invocationCallOrder[0]!,
    );
    const draftEvent = events.find((event) => event.event === "knowledge_draft.create");
    expect(draftEvent).toMatchObject({ event: "knowledge_draft.create", outcome: "failed", sourceCount: 1, errorType: "storage_unavailable" });
    expect(Object.keys(draftEvent ?? {}).sort()).toEqual(["errorType", "event", "outcome", "sourceCount", "timestamp"]);
    expect(JSON.stringify(events)).not.toContain("D1 draft secret");
  });

  it("does not draft sufficient knowledge, weather, fallback, or knowledge-only grounding", async () => {
    const knowledgeDrafts = { createOrRefresh: vi.fn().mockResolvedValue(undefined) };
    const kb = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Run at six.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-18T00:00:00.000Z", score: .9 } as const;
    const grounded = { answer: vi.fn().mockResolvedValue({ text: "Run at six.", model: "m", citations: [], usedEvidenceIds: [kb.id], validatedClaims: [{ text: "Run at six.", evidenceIds: [kb.id] }] }) };
    const common = { retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [kb], insufficient: false, topScore: .9 }) }, webSearch: { search: vi.fn() }, groundedAnswerService: grounded, knowledgeDrafts };

    await processQuestion(job, { ...deps(), ...common });
    await processQuestion({ ...job, text: "hello!" }, { ...deps(), retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) }, webSearch: { search: vi.fn().mockRejectedValue(new Error("down")) }, groundedAnswerService: { answer: vi.fn() }, knowledgeDrafts });
    await processQuestion({ ...job, text: "Taipei weather" }, { ...deps(), weatherService: { answer: vi.fn().mockResolvedValue({ text: "Weather", model: "weather" }) }, ...common });
    await processQuestion({ ...job, text: "What time is it?" }, { ...deps(), retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) }, webSearch: { search: vi.fn().mockRejectedValue(new Error("down")) }, groundedAnswerService: { answer: vi.fn() }, knowledgeDrafts });

    expect(knowledgeDrafts.createOrRefresh).not.toHaveBeenCalled();
  });

  it("does not recreate drafts on prepared or completed retries", async () => {
    const knowledgeDrafts = { createOrRefresh: vi.fn().mockResolvedValue(undefined) };
    const services = { retriever: { retrieve: vi.fn() }, webSearch: { search: vi.fn() }, groundedAnswerService: { answer: vi.fn() }, knowledgeDrafts };

    await processQuestion(job, { ...deps({ ...claimed, prepared: { text: "saved", model: "saved-model", status: "answered" } }), ...services });
    await processQuestion(job, { ...deps({ state: "completed" }), ...services });

    expect(knowledgeDrafts.createOrRefresh).not.toHaveBeenCalled();
  });

  it("keeps casual greetings out of retrieval, web search, grounding, and drafts", async () => {
    const events: TelemetryEvent[] = [];
    const d = { ...deps(), logger: { emit: (event: TelemetryEvent) => events.push(event) } };
    d.answerService.answer.mockImplementation(async (_request, observe) => {
      observe?.({ type: "attempt.started", provider: "workers_ai", role: "primary", model: "casual-model" });
      return { text: "Try the riverside.", model: "casual-model" };
    });
    const web = { id: "web:run", sourceType: "web", title: "Official run guide", url: "https://example.gov/run", text: "The route opens at six.", pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-18T00:00:00.000Z", score: .9 } as const;
    const retriever = { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) };
    const webSearch = { search: vi.fn().mockResolvedValue([web]) };
    const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "The route opens at six.", model: "grounded-model", citations: [], usedEvidenceIds: [web.id], validatedClaims: [{ text: "The route opens at six.", evidenceIds: [web.id] }] }) };
    const knowledgeDrafts = { createOrRefresh: vi.fn().mockResolvedValue(undefined) };

    await expect(processQuestion({ ...job, text: "hello!" }, { ...d, retriever, webSearch, groundedAnswerService, knowledgeDrafts }))
      .resolves.toEqual({ disposition: "ack", status: "answered" });

    expect(d.answerService.answer).toHaveBeenCalledWith({
      question: "hello!", locale: "zh-TW", groupId: job.groupId, defaultLocation: null,
    }, expect.any(Function));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      event: "answer.ai.attempt.started", model: "casual-model", detail: "primary_model",
    })]));
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(webSearch.search).not.toHaveBeenCalled();
    expect(groundedAnswerService.answer).not.toHaveBeenCalled();
    expect(knowledgeDrafts.createOrRefresh).not.toHaveBeenCalled();
  });

  it("does not create a draft when prepare fencing rejects the answer", async () => {
    const d = deps(); d.questions.prepare.mockRejectedValueOnce(new Error("stale claim"));
    const web = { id: "web:run", sourceType: "web", title: "Official run guide", url: "https://example.gov/run", text: "The route opens at six.", pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-18T00:00:00.000Z", score: .9 } as const;
    const knowledgeDrafts = { createOrRefresh: vi.fn().mockResolvedValue(undefined) };
    const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "The route opens at six.", model: "grounded-model", citations: [], usedEvidenceIds: [web.id], validatedClaims: [{ text: "The route opens at six.", evidenceIds: [web.id] }] }) };

    await expect(processQuestion({ ...job, text: "search online for run time" }, {
      ...d, retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) }, webSearch: { search: vi.fn().mockResolvedValue([web]) }, groundedAnswerService, knowledgeDrafts,
    })).resolves.toEqual({ disposition: "retry", delaySeconds: 1 });

    expect(knowledgeDrafts.createOrRefresh).not.toHaveBeenCalled();
    expect(d.lineClient.reply).not.toHaveBeenCalled();
  });
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
