import type { Fetcher } from "./line/client";

export type Env = WorkerEnv & {
  FETCHER?: Fetcher;
};
