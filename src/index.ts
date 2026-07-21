import { Hono } from "hono";

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
import { registerKnowledgeAdminRoutes, type KnowledgeAdminRepository } from "./knowledge/admin-routes";
import { KnowledgeRepository } from "./knowledge/repository";
import { R2KnowledgeObjectStore, type KnowledgeObjectStore } from "./knowledge/storage";
import type { ValidatedKnowledgeFile } from "./knowledge/file-validation";
import { TavilySafeUrlFetcher, type SafeUrlFetcher } from "./knowledge/url-safety";

type QuestionsDependency = ProcessDependencies["questions"] & Pick<QuestionsRepository, "purgeExpired">;
type QuestionsFactory = (env: Env) => QuestionsDependency;
type KnowledgeFactory = (env: Env) => KnowledgeAdminRepository;

type WorkerDependencies = {
  fetcher?: typeof fetch;
  now?: () => Date;
  queue?: Pick<Queue<QuestionJob>, "send">;
  questions?: QuestionsDependency | QuestionsFactory;
  knowledge?: KnowledgeAdminRepository | KnowledgeFactory;
  objectStore?: KnowledgeObjectStore | ((env: Env) => KnowledgeObjectStore);
  ingestionQueue?: Pick<Queue<import("./knowledge/types").IngestionJobMessage>, "send">;
  validateFile?: (file: File) => Promise<ValidatedKnowledgeFile>;
  safeUrlFetcher?: SafeUrlFetcher | ((env: Env) => SafeUrlFetcher);
};

export function createWorker(overrides: WorkerDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const questionsFor = (env: Env): QuestionsDependency => {
    if (typeof overrides.questions === "function") return overrides.questions(env);
    return overrides.questions ?? new QuestionsRepository(env.DB);
  };
  const knowledgeFor = (env: Env): KnowledgeAdminRepository => {
    if (typeof overrides.knowledge === "function") return overrides.knowledge(env);
    return overrides.knowledge ?? new KnowledgeRepository(env.DB);
  };
  const objectStoreFor = (env: Env): KnowledgeObjectStore => typeof overrides.objectStore === "function" ? overrides.objectStore(env) : overrides.objectStore ?? new R2KnowledgeObjectStore(env.FILES);

const safeUrlFetcherFor = (env: Env): SafeUrlFetcher => typeof overrides.safeUrlFetcher === "function" ? overrides.safeUrlFetcher(env) : overrides.safeUrlFetcher ?? new TavilySafeUrlFetcher(overrides.fetcher ?? fetch, env.TAVILY_API_KEY, overrides.now);
registerKnowledgeAdminRoutes(app, { repositoryFor: knowledgeFor, objectStoreFor, queueFor: (env) => overrides.ingestionQueue ?? env.INGESTION_QUEUE, validateFile: overrides.validateFile, safeUrlFetcherFor, now: overrides.now });

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

  const messages = selectMentionedMessages(payload, context.env.LINE_GROUP_ID);
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
      answerService: new OpenRouterAnswerService(fetcher, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL),
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
