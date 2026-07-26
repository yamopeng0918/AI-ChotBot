export interface AnswerRequest {
  question: string;
  locale: "zh-TW";
  groupId?: string;
  defaultLocation?: string | null;
}

export interface AnswerResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type AnswerProviderRole = "primary" | "fallback";
export type AnswerProviderFailureReason = "rate_limited" | "provider_error" | "timeout";
export type AnswerProviderEvent =
  | {
      type: "attempt.started";
      provider: "workers_ai";
      role: AnswerProviderRole;
      model: string;
    }
  | {
      type: "attempt.completed";
      provider: "workers_ai";
      role: AnswerProviderRole;
      model: string;
      durationMs: number;
    }
  | {
      type: "attempt.failed";
      provider: "workers_ai";
      role: AnswerProviderRole;
      model: string;
      reason: AnswerProviderFailureReason;
      durationMs: number;
    }
  | {
      type: "fallback.started";
      provider: "workers_ai";
      role: "fallback";
      model: string;
      reason: AnswerProviderFailureReason;
    };

export type AnswerProviderObserver = (event: AnswerProviderEvent) => void;

export interface AnswerService {
  answer(request: AnswerRequest, observe?: AnswerProviderObserver): Promise<AnswerResult>;
}
