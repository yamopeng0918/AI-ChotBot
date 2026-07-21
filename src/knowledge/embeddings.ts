export type EmbeddingErrorCode =
  | "embedding_timeout" | "embedding_rate_limited" | "embedding_upstream" | "embedding_failed"
  | "embedding_input_too_long" | "embedding_invalid_response" | "embedding_count_mismatch"
  | "embedding_dimension_mismatch" | "embedding_non_finite";

export class EmbeddingError extends Error {
  constructor(public readonly code: EmbeddingErrorCode, public readonly retryable: boolean) {
    super(code); this.name = "EmbeddingError";
  }
}

type WorkersAI = { run(model: "@cf/baai/bge-m3", input: { text: string[] }): Promise<unknown> };
type TimeoutSchedule = (milliseconds: number, reject: (error: EmbeddingError) => void) => () => void;

export class EmbeddingService {
  constructor(private readonly ai: WorkersAI, private readonly options: { schedule?: TimeoutSchedule } = {}) {}

  async embed(texts: string[]): Promise<number[][]> {
    for (const text of texts) {
      if ([...text].length > 8_000) throw new EmbeddingError("embedding_input_too_long", false);
    }
    const output: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 32) {
      const batch = texts.slice(offset, offset + 32);
      output.push(...await this.embedBatch(batch));
    }
    return output;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let cancelTimeout = () => {};
    const timeout = new Promise<never>((_, reject) => {
      const schedule = this.options.schedule ?? defaultSchedule;
      cancelTimeout = schedule(10_000, reject);
    });
    try {
      const raw = await Promise.race([this.ai.run("@cf/baai/bge-m3", { text: texts }), timeout]);
      return validateResponse(raw, texts.length);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      const status = providerStatus(error);
      if (status === 429) throw new EmbeddingError("embedding_rate_limited", true);
      if (status !== null && status >= 500) throw new EmbeddingError("embedding_upstream", true);
      throw new EmbeddingError("embedding_failed", false);
    } finally {
      cancelTimeout();
    }
  }
}

function validateResponse(raw: unknown, count: number): number[][] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new EmbeddingError("embedding_invalid_response", false);
  if (raw.data.length !== count) throw new EmbeddingError("embedding_count_mismatch", false);
  const vectors = raw.data as unknown[];
  for (const item of vectors) {
    if (!Array.isArray(item) || item.length !== 1024) throw new EmbeddingError("embedding_dimension_mismatch", false);
    if (!item.every((value) => typeof value === "number" && Number.isFinite(value))) throw new EmbeddingError("embedding_non_finite", false);
  }
  return vectors as number[][];
}

function defaultSchedule(milliseconds: number, reject: (error: EmbeddingError) => void): () => void {
  const timer = setTimeout(() => reject(new EmbeddingError("embedding_timeout", true)), milliseconds);
  return () => clearTimeout(timer);
}
function providerStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const value = error.status ?? (isRecord(error.response) ? error.response.status : null);
  return typeof value === "number" ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
