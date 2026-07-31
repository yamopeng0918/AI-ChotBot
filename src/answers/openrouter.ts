import { buildSystemPrompt } from "./prompt";
import type {
  AnswerProviderFailureReason,
  AnswerProviderObserver,
  AnswerProviderRole,
  AnswerRequest,
  AnswerResult,
  AnswerService,
} from "./types";

export type AnswerUnavailableReason = AnswerProviderFailureReason;

export class AnswerUnavailableError extends Error {
  readonly reason: AnswerUnavailableReason;

  constructor(reason: AnswerUnavailableReason) {
    super(reason);
    this.name = "AnswerUnavailableError";
    this.reason = reason;
  }
}

type AiBinding = Pick<Ai, "run">;

interface WorkersAiResponse {
  response?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function responseText(payload: WorkersAiResponse | string): string {
  if (typeof payload === "string") {
    return payload.trim();
  }

  const direct = payload.response;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") {
    return choice.trim();
  }

  return "";
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = Reflect.get(error, "status");
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

const PRIMARY_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const FALLBACK_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const REQUEST_TIMEOUT_MS = 20_000;

export class WorkersAiAnswerService implements AnswerService {
  constructor(
    private readonly ai: AiBinding,
    private readonly model = PRIMARY_MODEL,
    private readonly fallbackModel = FALLBACK_MODEL,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private timestamp(): number {
    try {
      return this.now();
    } catch {
      return Date.now();
    }
  }

  private notify(observe: AnswerProviderObserver | undefined, event: Parameters<AnswerProviderObserver>[0]): void {
    try {
      observe?.(event);
    } catch {
      // Observability must never change provider behavior.
    }
  }

  private async attempt(
    model: string,
    role: AnswerProviderRole,
    request: AnswerRequest,
    observe?: AnswerProviderObserver,
  ): Promise<AnswerResult> {
    const startedAt = this.timestamp();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.notify(observe, {
      type: "attempt.started",
      provider: "workers_ai",
      role,
      model,
    });

    try {
      const payload = (await this.ai.run(
        model,
        {
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: request.question },
          ],
          temperature: 0.3,
          max_tokens: 700,
        },
        { signal: controller.signal },
      )) as WorkersAiResponse | string;

      const text = responseText(payload);
      if (!text) {
        console.info("openrouter:empty-content");
        throw new AnswerUnavailableError("provider_error");
      }

      const usage = typeof payload === "object" && payload !== null ? payload.usage : undefined;
      const result = {
        text,
        model,
        inputTokens: tokenCount(usage?.prompt_tokens ?? null),
        outputTokens: tokenCount(usage?.completion_tokens ?? null),
      };
      this.notify(observe, {
        type: "attempt.completed",
        provider: "workers_ai",
        role,
        model,
        durationMs: Math.max(0, this.timestamp() - startedAt),
      });
      return result;
    } catch (error) {
      const classified =
        error instanceof AnswerUnavailableError
          ? error
          : errorStatus(error) === 429
            ? new AnswerUnavailableError("rate_limited")
            : controller.signal.aborted
              ? new AnswerUnavailableError("timeout")
              : new AnswerUnavailableError("provider_error");
      this.notify(observe, {
        type: "attempt.failed",
        provider: "workers_ai",
        role,
        model,
        reason: classified.reason,
        durationMs: Math.max(0, this.timestamp() - startedAt),
      });
      throw classified;
    } finally {
      clearTimeout(timeout);
    }
  }

  async answer(request: AnswerRequest, observe?: AnswerProviderObserver): Promise<AnswerResult> {
    if (!this.fallbackModel || this.fallbackModel === this.model) {
      return this.attempt(this.model, "primary", request, observe);
    }

    let sawRateLimited = false;
    let primaryFailure: AnswerUnavailableReason = "provider_error";

    try {
      return await this.attempt(this.model, "primary", request, observe);
    } catch (error) {
      if (!(error instanceof AnswerUnavailableError)) {
        throw error;
      }
      primaryFailure = error.reason;
      if (error.reason === "rate_limited") {
        sawRateLimited = true;
      }
    }

    this.notify(observe, {
      type: "fallback.started",
      provider: "workers_ai",
      role: "fallback",
      model: this.fallbackModel,
      reason: primaryFailure,
    });

    try {
      return await this.attempt(this.fallbackModel, "fallback", request, observe);
    } catch (error) {
      if (!(error instanceof AnswerUnavailableError)) {
        throw error;
      }
      if (error.reason === "rate_limited") {
        sawRateLimited = true;
      }
      throw new AnswerUnavailableError(sawRateLimited ? "rate_limited" : error.reason);
    }
  }
}
