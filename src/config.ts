import type { QuestionJob } from "./jobs/types";
import type { Fetcher } from "./line/client";

export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_GROUP_ID: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  MESSAGE_QUEUE: Queue<QuestionJob>;
  DB: D1Database;
  FETCHER?: Fetcher;
}
