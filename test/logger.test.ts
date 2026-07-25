import { describe, expect, it, vi } from "vitest";

import { createConsoleTelemetryLogger, type TelemetryEvent } from "../src/telemetry/logger";

describe("structured telemetry logger", () => {
  it("writes one JSON object with stable correlation fields", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);

    logger.emit({
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      intent: "weather",
      model: "open-meteo",
      durationMs: 125,
    });

    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      intent: "weather",
      model: "open-meteo",
      durationMs: 125,
    });
  });

  it("does not expose arbitrary fields through the event contract", () => {
    const event = {
      event: "line.reply.failed",
      stage: "line",
      outcome: "fallback",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      errorType: "line_reply_failed",
    } satisfies TelemetryEvent;

    expect(Object.keys(event)).not.toEqual(
      expect.arrayContaining(["question", "answer", "userId", "groupId", "replyToken", "error"]),
    );
  });

  it("omits prohibited runtime properties from the emitted JSON", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);
    const event = {
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      timestamp: "2026-07-25T10:00:00.000Z",
      question: "private question",
      answer: "private answer",
      userId: "user-1",
      groupId: "group-1",
      replyToken: "reply-token",
      error: "private error",
    } as unknown as TelemetryEvent;

    logger.emit(event);

    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      timestamp: "2026-07-25T10:00:00.000Z",
    });
  });

  it("does not throw when writing or serializing telemetry fails", () => {
    const throwingWriter = createConsoleTelemetryLogger(() => {
      throw new Error("write failed");
    });
    const serializationHazard = {
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      timestamp: "2026-07-25T10:00:00.000Z",
      durationMs: BigInt(125),
    } as unknown as TelemetryEvent;
    const serializingLogger = createConsoleTelemetryLogger();

    expect(() =>
      throwingWriter.emit({
        event: "question.completed",
        stage: "queue",
        outcome: "success",
        timestamp: "2026-07-25T10:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() => serializingLogger.emit(serializationHazard)).not.toThrow();
  });
});
