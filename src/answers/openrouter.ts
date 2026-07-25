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

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface OpenRouterResponse {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class OpenRouterAnswerService implements AnswerService {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fallbackModel?: string,
  ) {}

  private async attempt(model: string, request: AnswerRequest): Promise<AnswerResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: request.question },
          ],
          temperature: 0.3,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AnswerUnavailableError("rate_limited");
      }
      if (!response.ok) {
        throw new AnswerUnavailableError("provider_error");
      }

      let payload: OpenRouterResponse;
      try {
        payload = (await response.json()) as OpenRouterResponse;
      } catch {
        throw new AnswerUnavailableError("provider_error");
      }

      const rawContent = payload.choices?.[0]?.message?.content;
      const text = typeof rawContent === "string" ? rawContent.trim() : "";
      if (!text) {
        throw new AnswerUnavailableError("provider_error");
      }

      return {
        text,
        model: typeof payload.model === "string" && payload.model ? payload.model : model,
        inputTokens: tokenCount(payload.usage?.prompt_tokens),
        outputTokens: tokenCount(payload.usage?.completion_tokens),
      };
    } catch (error) {
      if (error instanceof AnswerUnavailableError) {
        throw error;
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
