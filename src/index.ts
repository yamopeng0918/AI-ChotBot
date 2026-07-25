import { Hono } from "hono";

import { isAdminCommand, parseAdminCommand } from "./admin/commands";
import { GroupAdminsRepository } from "./admin/group-admins";
import { handleAdminCommand } from "./admin/handler";
import { OpenRouterAnswerService } from "./answers/openrouter";
import type { Env } from "./config";
import { processQuestion } from "./jobs/process-message";
import type { QuestionJob } from "./jobs/types";
import { LineClient } from "./line/client";
import { selectMentionedMessages } from "./line/events";
import { verifyLineSignature } from "./line/signature";
import type { LineWebhookBody } from "./line/types";
import { QuestionsRepository, pseudonymizeUserId } from "./storage/questions";
import type { ProcessDependencies } from "./jobs/process-message";

type QuestionsDependency = ProcessDependencies["questions"] & Pick<QuestionsRepository, "purgeExpired">;
type QuestionsFactory = (env: Env) => QuestionsDependency;

type WorkerDependencies = {
  fetcher?: typeof fetch;
  now?: () => Date;
  queue?: Pick<Queue<QuestionJob>, "send">;
  questions?: QuestionsDependency | QuestionsFactory;
};

export function createWorker(overrides: WorkerDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const questionsFor = (env: Env): QuestionsDependency => {
    if (typeof overrides.questions === "function") return overrides.questions(env);
    return overrides.questions ?? new QuestionsRepository(env.DB);
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

  if (context.env.LINE_GROUP_ID === "__DISCOVER__") {
    for (const event of payload.events) {
      if (event.source?.type === "group" && typeof event.source.groupId === "string") {
        console.info(event.source.groupId);
      }
    }
    return context.json({ accepted: 0 });
  }

  const lineClient = new LineClient(overrides.fetcher ?? context.env.FETCHER ?? fetch, context.env.LINE_CHANNEL_ACCESS_TOKEN);
  const groupAdmins = new GroupAdminsRepository(context.env.DB);
  const queuePayload: LineWebhookBody = { ...payload, events: [] };

  for (const event of payload.events) {
    const shouldHandleAdminCommand =
      event.type === "message" &&
      event.message?.type === "text" &&
      typeof event.message.text === "string" &&
      (
        (event.source?.type === "group" && isAdminCommand(event)) ||
        (event.source?.type !== "group" && parseAdminCommand(event.message.text) !== null)
      );

    if (shouldHandleAdminCommand) {
      const result = await handleAdminCommand(event, {
        groupAdmins,
        bootstrapJson: context.env.GROUP_ADMINS_BOOTSTRAP_JSON,
      });

      if (result.handled) {
        if (result.replyText && event.replyToken) {
          try {
            await lineClient.reply(event.replyToken, result.replyText);
          } catch {
            return context.json({ error: "line unavailable" }, 503);
          }
        }
        continue;
      }
    }

    queuePayload.events.push(event);
  }

  const messages = selectMentionedMessages(queuePayload, context.env.LINE_GROUP_ID);
  try {
    for (const message of messages) {
      const job: QuestionJob = { ...message, receivedAt: (overrides.now?.() ?? new Date()).toISOString() };
      await (overrides.queue ?? context.env.MESSAGE_QUEUE).send(job);
    }
  } catch {
    return context.json({ error: "queue unavailable" }, 503);
  }

  return context.json({ accepted: messages.length });
});

return {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  async queue(batch: MessageBatch<QuestionJob>, env: Env, _context: ExecutionContext) {
    const fetcher = overrides.fetcher ?? env.FETCHER ?? fetch;
    const dependencies = {
      answerService: new OpenRouterAnswerService(
        fetcher,
        env.OPENROUTER_API_KEY,
        env.OPENROUTER_MODEL,
        env.OPENROUTER_FALLBACK_MODEL,
      ),
      lineClient: new LineClient(fetcher, env.LINE_CHANNEL_ACCESS_TOKEN),
      questions: questionsFor(env),
      pseudonymize: (userId: string | null) => pseudonymizeUserId(userId, env.ANALYTICS_HASH_KEY),
      now: overrides.now,
    };

    for (const message of batch.messages) {
      try {
        const result = await processQuestion(message.body, dependencies);
        if (result.disposition === "ack") message.ack(); else message.retry({ delaySeconds: result.delaySeconds });
      } catch {
        message.retry({ delaySeconds: 1 });
      }
    }
  },
  async scheduled(_controller, env) {
    await questionsFor(env).purgeExpired((overrides.now?.() ?? new Date()).toISOString());
  },
} satisfies ExportedHandler<Env, QuestionJob>;
}

const worker = createWorker();

export default worker;
