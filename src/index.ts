import { Hono } from "hono";

import { isAdminCommand, parseAdminCommand } from "./admin/commands";
import { GroupAdminsRepository } from "./admin/group-admins";
import { handleAdminCommand } from "./admin/handler";
import { WorkersAiAnswerService } from "./answers/openrouter";
import { GroundedAnswerService } from "./answers/grounded";
import {
  FallbackGroundedGenerator,
  OpenRouterGroundedGenerator,
  WorkersAiGroundedGenerator,
  type GroundedGeneratorEntry,
} from "./answers/grounded-generators";
import type { Env } from "./config";
import { processQuestion } from "./jobs/process-message";
import type { QuestionJob } from "./jobs/types";
import { LineClient } from "./line/client";
import { selectMentionedMessages } from "./line/events";
import { verifyLineSignature } from "./line/signature";
import type { LineWebhookBody } from "./line/types";
import { GroupSettingsRepository } from "./storage/group-settings";
import { QuestionsRepository, pseudonymizeUserId } from "./storage/questions";
import { WeatherCacheRepository } from "./storage/weather-cache";
import type { ProcessDependencies } from "./jobs/process-message";
import { OpenMeteoWeatherService } from "./weather/openmeteo";
import { D1MetricsRepository } from "./telemetry/metrics";
import {
  createConsoleTelemetryLogger,
  type TelemetryEventInput,
  type TelemetryLogger,
} from "./telemetry/logger";
import { registerKnowledgeAdminRoutes, type KnowledgeAdminRepository } from "./knowledge/admin-routes";
import { KnowledgeRepository } from "./knowledge/repository";
import { KnowledgeDraftRepository } from "./knowledge/drafts";
import { registerKnowledgeDraftRoutes, type KnowledgeDraftReviewRepository } from "./knowledge/draft-routes";
import { R2KnowledgeObjectStore, type KnowledgeObjectStore } from "./knowledge/storage";
import type { ValidatedKnowledgeFile } from "./knowledge/file-validation";
import { TavilySafeUrlFetcher, type SafeUrlFetcher } from "./knowledge/url-safety";
import { DocumentConverter } from "./knowledge/converter";
import { EmbeddingService } from "./knowledge/embeddings";
import { processIngestionJob, type IngestionDependencies } from "./knowledge/ingestion";
import { KnowledgeVectorStore } from "./knowledge/vector-store";
import type { IngestionJobMessage } from "./knowledge/types";
import { KnowledgeRetriever } from "./retrieval/retriever";
import { TavilySearchService, type WebSearchService } from "./search/tavily";

type QuestionsDependency = ProcessDependencies["questions"] & Pick<QuestionsRepository, "purgeExpired">;
type QuestionsFactory = (env: Env) => QuestionsDependency;
type KnowledgeFactory = (env: Env) => KnowledgeAdminRepository;
type RetrieverDependency = Pick<KnowledgeRetriever, "retrieve">;
type GroundedDependency = Pick<GroundedAnswerService, "answer">;
type KnowledgeDraftDependency = NonNullable<ProcessDependencies["knowledgeDrafts"]>;

export type WorkerDependencies = {
  fetcher?: typeof fetch;
  now?: () => Date;
  queue?: Pick<Queue<QuestionJob>, "send">;
  questions?: QuestionsDependency | QuestionsFactory;
  answerService?: ProcessDependencies["answerService"];
  weatherService?: ProcessDependencies["weatherService"];
  metrics?: ProcessDependencies["metrics"];
  logger?: TelemetryLogger;
  knowledge?: KnowledgeAdminRepository | KnowledgeFactory;
  objectStore?: KnowledgeObjectStore | ((env: Env) => KnowledgeObjectStore);
  ingestionQueue?: Pick<Queue<import("./knowledge/types").IngestionJobMessage>, "send">;
  validateFile?: (file: File) => Promise<ValidatedKnowledgeFile>;
  safeUrlFetcher?: SafeUrlFetcher | ((env: Env) => SafeUrlFetcher);
  ingestion?: IngestionDependencies | ((env: Env) => IngestionDependencies);
  retriever?: RetrieverDependency | ((env: Env) => RetrieverDependency);
  webSearch?: WebSearchService | ((env: Env) => WebSearchService);
  groundedAnswerService?: GroundedDependency | ((env: Env) => GroundedDependency);
  knowledgeDrafts?: KnowledgeDraftDependency | ((env: Env) => KnowledgeDraftDependency);
  draftReviews?: KnowledgeDraftReviewRepository | ((env: Env) => KnowledgeDraftReviewRepository);
};

export function createWorker(overrides: WorkerDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const logger = overrides.logger ?? createConsoleTelemetryLogger();
  const now = () => {
    try {
      return overrides.now?.() ?? new Date();
    } catch {
      return new Date();
    }
  };
  const timestamp = () => now().toISOString();
  const durationMs = (startedAt: Date) => Math.max(0, now().getTime() - startedAt.getTime());
  const emit = (event: TelemetryEventInput) => {
    try {
      logger.emit({ ...event, timestamp: timestamp() });
    } catch {}
  };
  const questionsFor = (env: Env): QuestionsDependency => {
    if (typeof overrides.questions === "function") return overrides.questions(env);
    return overrides.questions ?? new QuestionsRepository(env.DB);
  };
  const groupSettingsFor = (env: Env): Pick<GroupSettingsRepository, "getWeatherCity" | "setWeatherCity" | "clearWeatherCity"> =>
    new GroupSettingsRepository(env.DB);
  const knowledgeFor = (env: Env): KnowledgeAdminRepository => {
    if (typeof overrides.knowledge === "function") return overrides.knowledge(env);
    return overrides.knowledge ?? new KnowledgeRepository(env.DB);
  };
  const objectStoreFor = (env: Env): KnowledgeObjectStore => typeof overrides.objectStore === "function" ? overrides.objectStore(env) : overrides.objectStore ?? new R2KnowledgeObjectStore(env.FILES);

const safeUrlFetcherFor = (env: Env): SafeUrlFetcher => typeof overrides.safeUrlFetcher === "function" ? overrides.safeUrlFetcher(env) : overrides.safeUrlFetcher ?? new TavilySafeUrlFetcher(overrides.fetcher ?? fetch, env.TAVILY_API_KEY, overrides.now);
const ingestionFor = (env: Env): IngestionDependencies => {
  if (typeof overrides.ingestion === "function") return overrides.ingestion(env);
  if (overrides.ingestion) return overrides.ingestion;
  const repository = new KnowledgeRepository(env.DB);
  return { repository, objectStore: new R2KnowledgeObjectStore(env.FILES), converter: new DocumentConverter(env.AI),
    embeddings: new EmbeddingService(env.AI), vectors: new KnowledgeVectorStore(env.VECTORIZE, (documentId, version) => repository.listVectorIds(documentId, version)), now: overrides.now };
};
registerKnowledgeAdminRoutes(app, { repositoryFor: knowledgeFor, objectStoreFor, queueFor: (env) => overrides.ingestionQueue ?? env.INGESTION_QUEUE, validateFile: overrides.validateFile, safeUrlFetcherFor, now: overrides.now });
const draftReviewsFor = (env: Env): KnowledgeDraftReviewRepository =>
  typeof overrides.draftReviews === "function" ? overrides.draftReviews(env) : overrides.draftReviews ?? new KnowledgeDraftRepository(env.DB);
registerKnowledgeDraftRoutes(app, {
  draftsFor: draftReviewsFor,
  knowledgeFor,
  objectStoreFor,
  queueFor: (env) => overrides.ingestionQueue ?? env.INGESTION_QUEUE,
  now: overrides.now,
});

app.get("/health", (context) => context.json({ status: "ok" }));

app.post("/webhooks/line", async (context) => {
  const operationId = crypto.randomUUID();
  const signature = context.req.header("x-line-signature");
  if (!signature) {
    emit({
      event: "webhook.rejected",
      stage: "webhook",
      outcome: "failed",
      operationId,
      errorType: "invalid_signature",
    });
    return context.json({ error: "invalid signature" }, 401);
  }

  const body = await context.req.text();
  const isValid = await verifyLineSignature(body, signature, context.env.LINE_CHANNEL_SECRET);
  if (!isValid) {
    emit({
      event: "webhook.rejected",
      stage: "webhook",
      outcome: "failed",
      operationId,
      errorType: "invalid_signature",
    });
    return context.json({ error: "invalid signature" }, 401);
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(body) as LineWebhookBody;
  } catch {
    emit({
      event: "webhook.rejected",
      stage: "webhook",
      outcome: "failed",
      operationId,
      errorType: "invalid_json",
    });
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
  const groupSettings = groupSettingsFor(context.env);
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
        groupSettings,
        bootstrapJson: context.env.GROUP_ADMINS_BOOTSTRAP_JSON,
      });

      if (result.handled) {
        if (result.replyText && event.replyToken) {
          const correlation =
            typeof event.webhookEventId === "string"
              ? { webhookEventId: event.webhookEventId }
              : { operationId };
          try {
            await lineClient.reply(event.replyToken, result.replyText);
            emit({
              event: "admin.reply.completed",
              stage: "line",
              outcome: "success",
              ...correlation,
            });
          } catch {
            emit({
              event: "admin.reply.failed",
              stage: "line",
              outcome: "failed",
              ...correlation,
              errorType: "line_reply_failed",
            });
            return context.json({ error: "line unavailable" }, 503);
          }
        }
        continue;
      }
    }

    queuePayload.events.push(event);
  }

  const messages = selectMentionedMessages(queuePayload, context.env.LINE_GROUP_ID);
  for (const message of messages) {
    const job: QuestionJob = { ...message, receivedAt: timestamp() };
    try {
      await (overrides.queue ?? context.env.MESSAGE_QUEUE).send(job);
      emit({
        event: "webhook.enqueue.completed",
        stage: "webhook",
        outcome: "success",
        webhookEventId: job.webhookEventId,
      });
    } catch {
      emit({
        event: "webhook.enqueue.failed",
        stage: "webhook",
        outcome: "failed",
        webhookEventId: job.webhookEventId,
        errorType: "queue_unavailable",
      });
      return context.json({ error: "queue unavailable" }, 503);
    }
  }

  return context.json({ accepted: messages.length });
});

return {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
  async queue(batch: MessageBatch<QuestionJob | IngestionJobMessage>, env: Env, _context: ExecutionContext) {
    const fetcher = overrides.fetcher ?? env.FETCHER ?? fetch;
    const answerService = overrides.answerService ?? new WorkersAiAnswerService(env.AI);
    const weatherService =
      overrides.weatherService ?? new OpenMeteoWeatherService(fetcher, new WeatherCacheRepository(env.DB), overrides.now);
    const metrics = overrides.metrics ?? new D1MetricsRepository(env.DB);
    const groupSettings = groupSettingsFor(env);
    const injectedKnowledgeAnswering = overrides.retriever && overrides.webSearch && overrides.groundedAnswerService ? {
      retriever: typeof overrides.retriever === "function" ? overrides.retriever(env) : overrides.retriever,
      webSearch: typeof overrides.webSearch === "function" ? overrides.webSearch(env) : overrides.webSearch,
      groundedAnswerService: typeof overrides.groundedAnswerService === "function" ? overrides.groundedAnswerService(env) : overrides.groundedAnswerService,
    } : null;
    const knowledgeAnswering: Pick<ProcessDependencies, "retriever" | "webSearch" | "groundedAnswerService"> = injectedKnowledgeAnswering ?? (env.AI && env.VECTORIZE && env.TAVILY_API_KEY ? (() => {
      const retrievalRepository = new KnowledgeRepository(env.DB);
      const entries: GroundedGeneratorEntry[] = [{
        provider: "openrouter",
        role: "primary",
        model: env.OPENROUTER_MODEL,
        generator: new OpenRouterGroundedGenerator(fetcher, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL),
      }];
      const fallbackModel = env.OPENROUTER_FALLBACK_MODEL?.trim();
      if (fallbackModel && fallbackModel !== env.OPENROUTER_MODEL) {
        entries.push({
          provider: "openrouter",
          role: "fallback",
          model: fallbackModel,
          generator: new OpenRouterGroundedGenerator(fetcher, env.OPENROUTER_API_KEY, fallbackModel),
        });
      }
      entries.push({
        provider: "workers_ai",
        role: "terminal",
        model: "@cf/meta/llama-3.2-3b-instruct",
        generator: new WorkersAiGroundedGenerator(env.AI),
      });
      const groundedGenerator = new FallbackGroundedGenerator(entries, (event) => {
        console.info("grounded:provider", event);
      });
      return {
        retriever: new KnowledgeRetriever(new EmbeddingService(env.AI), new KnowledgeVectorStore(env.VECTORIZE), retrievalRepository, { now: () => (overrides.now?.() ?? new Date()).toISOString() }),
        webSearch: new TavilySearchService(fetcher, env.TAVILY_API_KEY, () => (overrides.now?.() ?? new Date()).toISOString()),
        groundedAnswerService: new GroundedAnswerService(groundedGenerator),
      };
    })() : {});
    const knowledgeDrafts = knowledgeAnswering.retriever && knowledgeAnswering.webSearch && knowledgeAnswering.groundedAnswerService
      ? typeof overrides.knowledgeDrafts === "function"
        ? overrides.knowledgeDrafts(env)
        : overrides.knowledgeDrafts ?? new KnowledgeDraftRepository(env.DB)
      : undefined;
    const dependencies = {
      answerService,
      weatherService,
      ...knowledgeAnswering,
      ...(knowledgeDrafts ? { knowledgeDrafts } : {}),
      lineClient: new LineClient(fetcher, env.LINE_CHANNEL_ACCESS_TOKEN),
      questions: questionsFor(env),
      groupSettings,
      metrics,
      logger,
      pseudonymize: (userId: string | null) => pseudonymizeUserId(userId, env.ANALYTICS_HASH_KEY),
      now: overrides.now,
    };

    for (const message of batch.messages) {
      try {
        if (isIngestionJob(message.body)) {
          console.info("queue:ingestion", message.body.jobId, message.body.kind);
          const result = await processIngestionJob(message.body, ingestionFor(env));
          if (result.disposition === "ack") message.ack(); else message.retry({ delaySeconds: result.delaySeconds });
          continue;
        }
        if (!isQuestionJob(message.body)) {
          console.info("queue:unknown");
          message.retry({ delaySeconds: 1 });
          const item = message.body && typeof message.body === "object"
            ? message.body as Record<string, unknown>
            : {};
          emit({
            event: "queue.message.retry",
            stage: "queue",
            outcome: "retry",
            ...(typeof item.webhookEventId === "string"
              ? { webhookEventId: item.webhookEventId }
              : { operationId: crypto.randomUUID() }),
            retryDelaySeconds: 1,
            errorType: "unexpected_error",
          });
          continue;
        }
        console.info("queue:question", message.body.webhookEventId);
        const result = await processQuestion(message.body, dependencies);
        console.info("queue:result", message.body.webhookEventId, result.disposition, "status" in result ? result.status ?? "" : "");
        if (result.disposition === "ack") message.ack(); else message.retry({ delaySeconds: result.delaySeconds });
      } catch {
        console.info("queue:unexpected-error");
        message.retry({ delaySeconds: 1 });
        const correlation = isQuestionJob(message.body)
          ? { webhookEventId: message.body.webhookEventId }
          : { operationId: crypto.randomUUID() };
        emit({
          event: "queue.message.retry",
          stage: "queue",
          outcome: "retry",
          ...correlation,
          retryDelaySeconds: 1,
          errorType: "unexpected_error",
        });
      }
    }
  },
  async scheduled(_controller, env) {
    const startedAt = now();
    const operationId = crypto.randomUUID();
    emit({ event: "cron.cleanup.started", stage: "cron", outcome: "success", operationId });
    const cleanupAt = timestamp();
    const results = await Promise.allSettled([
      questionsFor(env).purgeExpired(cleanupAt),
      draftReviewsFor(env).purgeExpired(cleanupAt),
    ]);
    if (results.every((result) => result.status === "fulfilled")) {
      emit({
        event: "cron.cleanup.completed",
        stage: "cron",
        outcome: "success",
        operationId,
        durationMs: durationMs(startedAt),
      });
      return;
    }
    emit({
      event: "cron.cleanup.failed",
      stage: "cron",
      outcome: "failed",
      operationId,
      errorType: "cron_cleanup_failed",
      durationMs: durationMs(startedAt),
    });
    throw new Error("scheduled cleanup failed");
  },
} satisfies ExportedHandler<Env, QuestionJob | IngestionJobMessage>;
}

function isIngestionJob(value: unknown): value is IngestionJobMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.jobId === "string" && typeof item.documentId === "string"
    && (item.kind === "ingest" || item.kind === "reindex" || item.kind === "delete");
}
function isQuestionJob(value: unknown): value is QuestionJob {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.webhookEventId === "string" && typeof item.messageId === "string"
    && typeof item.text === "string" && typeof item.receivedAt === "string";
}

const worker = createWorker();

export default worker;
