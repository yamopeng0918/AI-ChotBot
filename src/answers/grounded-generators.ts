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
  ) {
    super(reason);
    this.name = "GroundedProviderError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
