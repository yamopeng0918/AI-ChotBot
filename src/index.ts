import { Hono } from "hono";

import type { Env } from "./config";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (context) => context.json({ status: "ok" }));

const worker = {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  async queue() {},
  async scheduled() {},
} satisfies ExportedHandler<Env>;

export default worker;
