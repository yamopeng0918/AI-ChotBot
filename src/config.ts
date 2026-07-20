import type { QuestionJob } from "./jobs/types";
import type { IngestionJobMessage } from "./knowledge/types";
import type { Fetcher } from "./line/client";

export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_GROUP_ID: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  ANALYTICS_HASH_KEY: string;
  ADMIN_API_TOKEN: string;
  TAVILY_API_KEY: string;
  MESSAGE_QUEUE: Queue<QuestionJob>;
  INGESTION_QUEUE: Queue<IngestionJobMessage>;
  DB: D1Database;
  FILES: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  FETCHER?: Fetcher;
}
