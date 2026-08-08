import type { IngestionJobMessage } from "./knowledge/types";
import type { Fetcher } from "./line/client";

export type Env = WorkerEnv & {
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_FALLBACK_MODEL?: string;
  ADMIN_API_TOKEN: string;
  TAVILY_API_KEY: string;
  INGESTION_QUEUE: Queue<IngestionJobMessage>;
  FILES: R2Bucket;
  VECTORIZE: VectorizeIndex;
  FETCHER?: Fetcher;
};
