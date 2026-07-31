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
  ) {}

  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await this.fetcher.call(globalThis, "https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: request.question },
          ],
          temperature: 0.3,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (response.status === 429) {
        console.info("openrouter:response", response.status);
        throw new AnswerUnavailableError("rate_limited");
      }
      if (!response.ok) {
        console.info("openrouter:response", response.status);
        throw new AnswerUnavailableError("provider_error");
      }

      let payload: OpenRouterResponse & { error?: unknown };
      try {
        payload = JSON.parse(raw) as OpenRouterResponse & { error?: unknown };
      } catch {
        console.info("openrouter:malformed");
        throw new AnswerUnavailableError("provider_error");
      }

      if (payload.error) {
        console.info("openrouter:payload-error");
      }
      const choice = payload.choices?.[0];
      const rawContent = choice?.message?.content;
      const text = typeof rawContent === "string" ? rawContent.trim() : "";
      if (!text) {
        console.info("openrouter:empty-content");
        throw new AnswerUnavailableError("provider_error");
      }

      return {
        text,
        model: typeof payload.model === "string" && payload.model ? payload.model : this.model,
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
}
