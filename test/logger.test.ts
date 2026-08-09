import { describe, expect, it, vi } from "vitest";

import { createConsoleTelemetryLogger, type TelemetryEvent } from "../src/telemetry/logger";

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ForbiddenTelemetryKey =
  | "question"
  | "answer"
  | "claim"
  | "evidence"
  | "userId"
  | "groupId"
  | "replyToken"
  | "authorization"
  | "markdown"
  | "url"
  | "snippet"
  | "token"
  | "providerPayload"
  | "accessToken"
  | "secret"
  | "error";
type AssertNever<T extends never> = T;
type ForbiddenTelemetryKeysMustRemainAbsent = AssertNever<
  Extract<KeysOfUnion<TelemetryEvent>, ForbiddenTelemetryKey>
>;

const webhookCorrelatedEvent = {
  event: "question.completed",
  stage: "queue",
  outcome: "success",
  webhookEventId: "event-1",
  timestamp: "2026-07-25T10:00:00.000Z",
} satisfies TelemetryEvent;

const operationCorrelatedEvent = {
  event: "cron.cleanup.completed",
  stage: "cron",
  outcome: "success",
  operationId: "operation-1",
  timestamp: "2026-07-25T10:00:00.000Z",
} satisfies TelemetryEvent;

// @ts-expect-error Telemetry events require one correlation identifier.
const missingCorrelationEvent: TelemetryEvent = {
  event: "webhook.rejected",
  stage: "webhook",
  outcome: "failed",
  timestamp: "2026-07-25T10:00:00.000Z",
  errorType: "invalid_signature",
};

// @ts-expect-error Telemetry events cannot combine request and webhook identifiers.
const conflictingCorrelationEvent: TelemetryEvent = {
  event: "question.completed",
  stage: "queue",
  outcome: "success",
  webhookEventId: "event-1",
  operationId: "operation-1",
  timestamp: "2026-07-25T10:00:00.000Z",
};

void (null as unknown as ForbiddenTelemetryKeysMustRemainAbsent);
void webhookCorrelatedEvent;
void operationCorrelatedEvent;
void missingCorrelationEvent;
void conflictingCorrelationEvent;

describe("structured telemetry logger", () => {
  it("writes one allowlisted record object with stable correlation fields", () => {
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
    expect(write).toHaveBeenCalledWith({
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

  it("omits prohibited runtime properties from the emitted object", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);
    const event = {
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      timestamp: "2026-07-25T10:00:00.000Z",
      webhookEventId: "event-1",
      question: "private question",
      answer: "private answer",
      userId: "user-1",
      groupId: "group-1",
      replyToken: "reply-token",
      error: "private error",
    } as unknown as TelemetryEvent;

    logger.emit(event);

    expect(write).toHaveBeenCalledWith({
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      timestamp: "2026-07-25T10:00:00.000Z",
      webhookEventId: "event-1",
    });
  });

  it("projects draft telemetry to metadata only", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);
    logger.emit({
      event: "knowledge_draft.create", outcome: "success", sourceCount: 1,
      timestamp: "2026-07-25T10:00:00.000Z",
      question: "private", answer: "private", markdown: "# private",
      url: "https://private.example", snippet: "private", authorization: "Bearer private",
      token: "private", providerPayload: { private: true },
    } as unknown as TelemetryEvent);

    expect(write).toHaveBeenCalledWith({
      event: "knowledge_draft.create", outcome: "success", sourceCount: 1,
      timestamp: "2026-07-25T10:00:00.000Z",
    });
  });

  it("projects grounded validation telemetry without injected content", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);
    logger.emit({
      event: "answer.grounded.validation", stage: "answer", outcome: "failed",
      reason: "entailment_failed", attempt: 1, model: "grounded-model",
      timestamp: "2026-07-25T10:00:00.000Z",
      question: "private question", answer: "private answer", claim: "private claim", evidence: "private evidence",
      url: "https://private.example", snippet: "private snippet", providerPayload: { private: true },
      authorization: "Bearer private", token: "private token",
    } as unknown as TelemetryEvent);

    expect(write).toHaveBeenCalledWith({
      event: "answer.grounded.validation", stage: "answer", outcome: "failed",
      reason: "entailment_failed", attempt: 1, model: "grounded-model",
      timestamp: "2026-07-25T10:00:00.000Z",
    });
  });

  it("projects only the discarded claim count for successful grounded validation", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);
    logger.emit({
      event: "answer.grounded.validation", stage: "answer", outcome: "success",
      reason: "validated", attempt: 1, model: "grounded-model", selectedSentenceCount: 3, discardedClaimCount: 2,
      timestamp: "2026-07-25T10:00:00.000Z",
      question: "private question", claim: "private claim", evidence: "private evidence",
      url: "https://private.example", token: "private token",
    } as unknown as TelemetryEvent);

    expect(write).toHaveBeenCalledWith({
      event: "answer.grounded.validation", stage: "answer", outcome: "success",
      reason: "validated", attempt: 1, model: "grounded-model", selectedSentenceCount: 3, discardedClaimCount: 2,
      timestamp: "2026-07-25T10:00:00.000Z",
    });
    const serialized = JSON.stringify(write.mock.calls);
    for (const forbidden of ["private question", "private claim", "private evidence", "https://private.example", "private token", "\"question\":", "\"claim\":", "\"evidence\":", "\"url\":", "\"token\":"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not throw when projection or writing telemetry fails", () => {
    const throwingWriter = createConsoleTelemetryLogger(() => {
      throw new Error("write failed");
    });
    const projectionHazard = {
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
    } as TelemetryEvent;
    Object.defineProperty(projectionHazard, "event", {
      get() {
        throw new Error("projection failed");
      },
    });
    const projectingLogger = createConsoleTelemetryLogger(vi.fn());

    expect(() =>
      throwingWriter.emit({
        event: "question.completed",
        stage: "queue",
        outcome: "success",
        webhookEventId: "event-1",
        timestamp: "2026-07-25T10:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() => projectingLogger.emit(projectionHazard)).not.toThrow();
  });

  it("passes an allowlisted object to the production console sink", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createConsoleTelemetryLogger();

    try {
      logger.emit(webhookCorrelatedEvent);
      expect(log).toHaveBeenCalledWith(webhookCorrelatedEvent);
    } finally {
      log.mockRestore();
    }
  });
});
