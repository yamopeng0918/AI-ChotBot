import { Hono } from "hono";

import type { Env } from "./config";
import type { QuestionJob } from "./jobs/types";
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

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(body) as LineWebhookBody;
  } catch {
    return context.json({ error: "invalid JSON" }, 400);
  }

  const messages = selectMentionedMessages(payload, context.env.LINE_GROUP_ID);
  for (const message of messages) {
    const receivedAt = new Date().toISOString();
    let claimed = false;

    try {
      const result = await context.env.DB.prepare(
        "INSERT OR IGNORE INTO line_webhook_receipts (webhook_event_id, received_at) VALUES (?, ?)",
      ).bind(message.webhookEventId, receivedAt).run();
      claimed = result.meta.changes === 1;
      if (!claimed) continue;

      const job: QuestionJob = { ...message, receivedAt };
      await context.env.MESSAGE_QUEUE.send(job);
    } catch {
      if (claimed) {
        try {
          await context.env.DB.prepare(
            "DELETE FROM line_webhook_receipts WHERE webhook_event_id = ?",
          ).bind(message.webhookEventId).run();
        } catch {
          // Preserve the retry response even if D1 is temporarily unavailable.
        }
      }
      return context.json({ error: "queue unavailable" }, 503);
    }
  }

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
