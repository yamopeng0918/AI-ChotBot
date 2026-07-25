import type { QuestionJob } from "./jobs/types";
import type { Fetcher } from "./line/client";

export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_GROUP_ID: string;
  ANALYTICS_HASH_KEY: string;
  GROUP_ADMINS_BOOTSTRAP_JSON: string;
  MESSAGE_QUEUE: Queue<QuestionJob>;
  DB: D1Database;
  AI: Ai;
  FETCHER?: Fetcher;
}
