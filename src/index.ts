import { Hono } from "hono";

import { OpenRouterAnswerService } from "./answers/openrouter";
import type { Env } from "./config";
import { processQuestion, type QuestionRecorder } from "./jobs/process-message";
import type { QuestionJob } from "./jobs/types";
import { LineClient, LineReplyError } from "./line/client";
import { selectMentionedMessages } from "./line/events";
import { verifyLineSignature } from "./line/signature";
import type { LineWebhookBody } from "./line/types";

const app = new Hono<{ Bindings: Env }>();

const noOpRecorder: QuestionRecorder = {
  async record() {},
};

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
  try {
    for (const message of messages) {
      const job: QuestionJob = { ...message, receivedAt: new Date().toISOString() };
      await context.env.MESSAGE_QUEUE.send(job);
    }
  } catch {
    return context.json({ error: "queue unavailable" }, 503);
  }

  return context.json({ accepted: messages.length });
});

const worker = {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  async queue(batch: MessageBatch<QuestionJob>, env: Env, _context: ExecutionContext) {
    const fetcher = env.FETCHER ?? fetch;
    const dependencies = {
      answerService: new OpenRouterAnswerService(fetcher, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL),
      lineClient: new LineClient(fetcher, env.LINE_CHANNEL_ACCESS_TOKEN),
      recorder: noOpRecorder,
    };

    for (const message of batch.messages) {
      try {
        await processQuestion(message.body, dependencies);
        message.ack();
      } catch (error) {
        if (error instanceof LineReplyError) {
          message.retry();
        } else {
          message.ack();
        }
      }
    }
  },
  async scheduled() {},
} satisfies ExportedHandler<Env, QuestionJob>;

export default worker;
