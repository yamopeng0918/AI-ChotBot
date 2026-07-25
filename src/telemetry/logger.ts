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
      write(JSON.stringify(event));
    },
  };
}
