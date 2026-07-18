import { Hono } from "hono";

import type { Env } from "./config";
import { selectMentionedMessages } from "./line/events";
import { verifyLineSignature } from "./line/signature";
import type { LineWebhookBody } from "./line/types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (context) => context.json({ status: "ok" }));

app.post("/webhooks/line", async (context) => {
  const signature = context.req.header("x-line-signature");
  if (!signature) return context.json({ error: "invalid signature" }, 401);

  const body = await context.req.text();
  const isValid = await verifyLineSignature(body, signature, context.env.LINE_CHANNEL_SECRET);
  if (!isValid) return context.json({ error: "invalid signature" }, 401);

  const payload = JSON.parse(body) as LineWebhookBody;
  const messages = selectMentionedMessages(payload, context.env.LINE_GROUP_ID);
  return context.json({ accepted: messages.length });
});

const worker = {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  async queue() {},
  async scheduled() {},
} satisfies ExportedHandler<Env>;

export default worker;
