import { buildSystemPrompt } from "./prompt";
import type { AnswerRequest, AnswerResult, AnswerService } from "./types";

export type AnswerUnavailableReason = "rate_limited" | "provider_error" | "timeout";

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
  constructor(private readonly ai: AiBinding, private readonly model = PRIMARY_MODEL, private readonly fallbackModel = FALLBACK_MODEL) {}

  private async attempt(model: string, request: AnswerRequest): Promise<AnswerResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
        throw new AnswerUnavailableError("provider_error");
      }

      const usage = typeof payload === "object" && payload !== null ? payload.usage : undefined;
      return {
        text,
        model,
        inputTokens: tokenCount(usage?.prompt_tokens ?? null),
        outputTokens: tokenCount(usage?.completion_tokens ?? null),
      };
    } catch (error) {
      if (error instanceof AnswerUnavailableError) {
        throw error;
      }
      if (errorStatus(error) === 429) {
        throw new AnswerUnavailableError("rate_limited");
      }
      if (controller.signal.aborted) {
        throw new AnswerUnavailableError("timeout");
      }
      throw new AnswerUnavailableError("provider_error");
    } finally {
      clearTimeout(timeout);
    }
  }

  async answer(request: AnswerRequest): Promise<AnswerResult> {
    if (!this.fallbackModel || this.fallbackModel === this.model) {
      return this.attempt(this.model, request);
    }

    let sawRateLimited = false;

    try {
      return await this.attempt(this.model, request);
    } catch (error) {
      if (!(error instanceof AnswerUnavailableError)) {
        throw error;
      }
      if (error.reason === "rate_limited") {
        sawRateLimited = true;
      }
    }

    try {
      return await this.attempt(this.fallbackModel, request);
    } catch (error) {
      if (!(error instanceof AnswerUnavailableError)) {
        throw error;
      }
      if (error.reason === "rate_limited") {
        sawRateLimited = true;
      }
      throw new AnswerUnavailableError(sawRateLimited ? "rate_limited" : "provider_error");
    }
  }
}
