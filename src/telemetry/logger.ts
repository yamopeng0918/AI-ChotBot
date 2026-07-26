export const TELEMETRY_EVENT_NAMES = [
  "webhook.rejected",
  "webhook.enqueue.completed",
  "webhook.enqueue.failed",
  "admin.reply.completed",
  "admin.reply.failed",
  "question.started",
  "question.deduplicated",
  "question.retry",
  "question.completed",
  "storage.claim.completed",
  "storage.claim.failed",
  "storage.prepare.completed",
  "storage.prepare.failed",
  "storage.complete.completed",
  "storage.complete.failed",
  "storage.release.failed",
  "answer.ai.attempt.started",
  "answer.ai.attempt.completed",
  "answer.ai.attempt.failed",
  "answer.ai.fallback.started",
  "answer.prepared.reused",
  "answer.completed",
  "answer.failed",
  "weather.settings.failed",
  "weather.cache.failed",
  "line.reply.completed",
  "line.reply.failed",
  "line.push.completed",
  "line.push.failed",
  "queue.message.retry",
  "cron.cleanup.started",
  "cron.cleanup.completed",
  "cron.cleanup.failed",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryStage = "webhook" | "queue" | "answer" | "line" | "storage" | "cron";
export type TelemetryOutcome = "success" | "retry" | "fallback" | "failed";

export type TelemetryErrorType =
  | "invalid_signature"
  | "invalid_json"
  | "queue_unavailable"
  | "lease_unavailable"
  | "storage_unavailable"
  | "ai_rate_limited"
  | "ai_timeout"
  | "ai_provider_error"
  | "weather_timeout"
  | "weather_provider_error"
  | "line_reply_failed"
  | "line_push_failed"
  | "cron_cleanup_failed"
  | "unexpected_error";

export type TelemetryDetail =
  | "primary_model"
  | "fallback_model"
  | "reply"
  | "push"
  | "reused_prepared"
  | "weather_settings"
  | "weather_cache_read"
  | "weather_cache_write";

type TelemetryCorrelation =
  | { webhookEventId: string; operationId?: never }
  | { operationId: string; webhookEventId?: never };

type TelemetryFields = {
  event: TelemetryEventName;
  stage: TelemetryStage;
  outcome: TelemetryOutcome;
  timestamp: string;
  intent?: "general" | "weather";
  model?: string | null;
  durationMs?: number;
  retryDelaySeconds?: number;
  errorType?: TelemetryErrorType;
  detail?: TelemetryDetail;
};

export type TelemetryEvent = TelemetryFields & TelemetryCorrelation;
export type TelemetryEventInput = TelemetryEvent extends infer Event
  ? Event extends TelemetryEvent
    ? Omit<Event, "timestamp">
    : never
  : never;
export type TelemetryRecord = TelemetryEvent;

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ForbiddenTelemetryKey =
  | "question"
  | "answer"
  | "userId"
  | "groupId"
  | "replyToken"
  | "authorization"
  | "accessToken"
  | "secret"
  | "error";
type AssertNever<T extends never> = T;
type _TelemetryEventMustExcludeForbiddenKeys = AssertNever<
  Extract<KeysOfUnion<TelemetryEvent>, ForbiddenTelemetryKey>
>;

export interface TelemetryLogger {
  emit(event: TelemetryEvent): void;
}

function projectEvent(event: TelemetryEvent): TelemetryRecord {
  const fields = {
    event: event.event,
    stage: event.stage,
    outcome: event.outcome,
    timestamp: event.timestamp,
    ...(event.intent !== undefined ? { intent: event.intent } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.retryDelaySeconds !== undefined
      ? { retryDelaySeconds: event.retryDelaySeconds }
      : {}),
    ...(event.errorType !== undefined ? { errorType: event.errorType } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };

  if (typeof event.webhookEventId === "string") {
    return { ...fields, webhookEventId: event.webhookEventId };
  }
  if (typeof event.operationId === "string") {
    return { ...fields, operationId: event.operationId };
  }
  throw new Error("telemetry correlation missing");
}

export function createConsoleTelemetryLogger(
  write: (record: TelemetryRecord) => void = (record) => console.log(record),
): TelemetryLogger {
  return {
    emit(event) {
      try {
        write(projectEvent(event));
      } catch {
        // Telemetry must never interrupt request processing.
      }
    },
  };
}
