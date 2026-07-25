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

export interface TelemetryEvent {
  event: string;
  stage: TelemetryStage;
  outcome: TelemetryOutcome;
  timestamp: string;
  webhookEventId?: string;
  operationId?: string;
  intent?: "general" | "weather";
  model?: string | null;
  durationMs?: number;
  retryDelaySeconds?: number;
  errorType?: TelemetryErrorType;
  detail?: "primary_model" | "fallback_model" | "reply" | "push" | "reused_prepared";
}

export interface TelemetryLogger {
  emit(event: TelemetryEvent): void;
}

export function createConsoleTelemetryLogger(
  write: (line: string) => void = (line) => console.log(line),
): TelemetryLogger {
  return {
    emit(event) {
      try {
        write(
          JSON.stringify({
            event: event.event,
            stage: event.stage,
            outcome: event.outcome,
            timestamp: event.timestamp,
            webhookEventId: event.webhookEventId,
            operationId: event.operationId,
            intent: event.intent,
            model: event.model,
            durationMs: event.durationMs,
            retryDelaySeconds: event.retryDelaySeconds,
            errorType: event.errorType,
            detail: event.detail,
          }),
        );
      } catch {
        // Telemetry must never interrupt request processing.
      }
    },
  };
}
