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
});
