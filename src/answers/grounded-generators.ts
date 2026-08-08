export type GroundedMessage = { role: "system" | "user"; content: string };
export type GroundedGeneration = { text: string; model: string };
export interface GroundedGenerator {
  generate(messages: GroundedMessage[]): Promise<GroundedGeneration>;
}

export type GroundedProviderFailureReason = "http" | "timeout" | "network" | "malformed";
export class GroundedProviderError extends Error {
  constructor(
    readonly reason: GroundedProviderFailureReason,
    readonly status?: number,
    readonly errorName?: "InferenceUpstreamError" | "AiInternalError",
    readonly code?: number,
  ) {
    super(reason);
    this.name = "GroundedProviderError";
  }
}

export type GroundedProviderRole = "primary" | "fallback" | "terminal";
export type GroundedProviderEvent = {
  type: "attempt.started" | "attempt.completed" | "attempt.failed" | "fallback.started";
  provider: "openrouter" | "workers_ai";
  role: GroundedProviderRole;
  model: string;
  durationMs?: number;
  reason?: GroundedProviderFailureReason;
  status?: number;
  errorName?: "InferenceUpstreamError" | "AiInternalError";
  code?: number;
};

export type GroundedGeneratorEntry = {
  provider: "openrouter" | "workers_ai";
  role: GroundedProviderRole;
  model: string;
  generator: GroundedGenerator;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AiBinding = Pick<Ai, "run">;
export const WORKERS_AI_GROUNDED_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const GROUNDED_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "claims"],
    properties: {
      answer: { type: "string", minLength: 1 },
      claims: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "evidenceIds"],
          properties: {
            text: { type: "string", minLength: 1 },
            evidenceIds: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

export class OpenRouterGroundedGenerator implements GroundedGenerator {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(messages: GroundedMessage[]): Promise<GroundedGeneration> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher.call(globalThis, "https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, response_format: { type: "json_object" }, temperature: 0, max_tokens: 900 }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        console.info("openrouter:grounded-response", response.status);
        throw new GroundedProviderError("http", response.status);
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw new GroundedProviderError("malformed"); }
      if (typeof payload !== "object" || payload === null) throw new GroundedProviderError("malformed");
      const choices = Reflect.get(payload, "choices");
      const first = Array.isArray(choices) && typeof choices[0] === "object" && choices[0] !== null ? choices[0] : null;
      const message = first && typeof Reflect.get(first, "message") === "object" ? Reflect.get(first, "message") as object : null;
      const content = message ? Reflect.get(message, "content") : null;
      if (typeof content !== "string" || !content.trim()) throw new GroundedProviderError("malformed");
      const returnedModel = Reflect.get(payload, "model");
      return { text: content, model: typeof returnedModel === "string" && returnedModel ? returnedModel : this.model };
    } catch (error) {
      if (error instanceof GroundedProviderError) throw error;
      if (controller.signal.aborted) throw new GroundedProviderError("timeout");
      throw new GroundedProviderError("network");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class WorkersAiGroundedGenerator implements GroundedGenerator {
  constructor(
    private readonly ai: AiBinding,
    private readonly model = WORKERS_AI_GROUNDED_MODEL,
  ) {}

  async generate(messages: GroundedMessage[]): Promise<GroundedGeneration> {
    let payload: unknown;
    try {
      payload = await this.ai.run(this.model, {
        messages,
        temperature: 0,
        max_tokens: 900,
        response_format: GROUNDED_RESPONSE_FORMAT,
      });
    } catch (error) {
      const metadata = workersAiErrorMetadata(error);
      throw new GroundedProviderError("network", metadata.status, metadata.errorName, metadata.code);
    }
    const text = workersAiResponseText(payload);
    if (!text) throw new GroundedProviderError("malformed");
    return { text, model: this.model };
  }
}

function workersAiErrorMetadata(error: unknown): {
  errorName?: "InferenceUpstreamError" | "AiInternalError";
  code?: number;
  status?: number;
} {
  if (error === null || typeof error !== "object") return {};

  const name = safeMetadataValue(error, "name");
  const code = safeMetadataValue(error, "code");
  const status = safeMetadataValue(error, "status");
  return {
    ...(name === "InferenceUpstreamError" || name === "AiInternalError" ? { errorName: name } : {}),
    ...(typeof code === "number" && Number.isFinite(code) ? { code } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? { status }
      : {}),
  };
}

function safeMetadataValue(error: object, key: "name" | "code" | "status"): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

function workersAiResponseText(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (!isPlainObject(payload)) return "";

  const response = payload.response;
  if (typeof response === "string") return response.trim();
  if (!isPlainObject(response)) return "";

  try {
    return JSON.stringify(response)?.trim() ?? "";
  } catch {
    return "";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export class FallbackGroundedGenerator implements GroundedGenerator {
  constructor(
    private readonly entries: GroundedGeneratorEntry[],
    private readonly observe?: (event: GroundedProviderEvent) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!entries.length) throw new RangeError("at least one grounded generator is required");
  }

  async generate(messages: GroundedMessage[]): Promise<GroundedGeneration> {
    let terminal: unknown = new Error("grounded model unavailable");
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index]!;
      if (index > 0) {
        this.notify({ type: "fallback.started", provider: entry.provider, role: entry.role, model: entry.model });
      }
      const startedAt = this.safeNow();
      this.notify({ type: "attempt.started", provider: entry.provider, role: entry.role, model: entry.model });
      try {
        const result = await entry.generator.generate(messages);
        this.notify({
          type: "attempt.completed",
          provider: entry.provider,
          role: entry.role,
          model: result.model,
          durationMs: Math.max(0, this.safeNow() - startedAt),
        });
        return result;
      } catch (error) {
        terminal = error;
        const failure = error instanceof GroundedProviderError
          ? {
              reason: error.reason,
              ...(error.status === undefined ? {} : { status: error.status }),
              ...(error.errorName === undefined ? {} : { errorName: error.errorName }),
              ...(error.code === undefined ? {} : { code: error.code }),
            }
          : { reason: "network" as const };
        this.notify({
          type: "attempt.failed",
          provider: entry.provider,
          role: entry.role,
          model: entry.model,
          durationMs: Math.max(0, this.safeNow() - startedAt),
          ...failure,
        });
      }
    }
    throw terminal;
  }

  private safeNow(): number {
    try {
      return this.now();
    } catch {
      return Date.now();
    }
  }

  private notify(event: GroundedProviderEvent): void {
    try {
      this.observe?.(event);
    } catch {}
  }
}
