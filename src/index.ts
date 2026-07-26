import { Hono } from "hono";

import { isAdminCommand, parseAdminCommand } from "./admin/commands";
import { GroupAdminsRepository } from "./admin/group-admins";
import { handleAdminCommand } from "./admin/handler";
import { WorkersAiAnswerService } from "./answers/openrouter";
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
import { createConsoleTelemetryLogger, type TelemetryEvent, type TelemetryLogger } from "./telemetry/logger";

type QuestionsDependency = ProcessDependencies["questions"] & Pick<QuestionsRepository, "purgeExpired">;
type QuestionsFactory = (env: Env) => QuestionsDependency;

export type WorkerDependencies = {
  fetcher?: typeof fetch;
  now?: () => Date;
  queue?: Pick<Queue<QuestionJob>, "send">;
  questions?: QuestionsDependency | QuestionsFactory;
  answerService?: ProcessDependencies["answerService"];
  weatherService?: ProcessDependencies["weatherService"];
  metrics?: ProcessDependencies["metrics"];
  logger?: TelemetryLogger;
};

export function createWorker(overrides: WorkerDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const logger = overrides.logger ?? createConsoleTelemetryLogger();
  const timestamp = () => (overrides.now?.() ?? new Date()).toISOString();
  const emit = (event: Omit<TelemetryEvent, "timestamp">) => {
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

app.get("/health", (context) => context.json({ status: "ok" }));

app.post("/webhooks/line", async (context) => {
  const signature = context.req.header("x-line-signature");
  if (!signature) {
    emit({ event: "webhook.rejected", stage: "webhook", outcome: "failed", errorType: "invalid_signature" });
    return context.json({ error: "invalid signature" }, 401);
  }

  const body = await context.req.text();
  const isValid = await verifyLineSignature(body, signature, context.env.LINE_CHANNEL_SECRET);
  if (!isValid) {
    emit({ event: "webhook.rejected", stage: "webhook", outcome: "failed", errorType: "invalid_signature" });
    return context.json({ error: "invalid signature" }, 401);
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(body) as LineWebhookBody;
  } catch {
    emit({ event: "webhook.rejected", stage: "webhook", outcome: "failed", errorType: "invalid_json" });
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
    emit({ event: "webhook.enqueue.failed", stage: "webhook", outcome: "failed", errorType: "queue_unavailable" });
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
    const answerService = overrides.answerService ?? new WorkersAiAnswerService(env.AI);
    const weatherService =
      overrides.weatherService ?? new OpenMeteoWeatherService(fetcher, new WeatherCacheRepository(env.DB), overrides.now);
    const metrics = overrides.metrics ?? new D1MetricsRepository(env.DB);
    const groupSettings = groupSettingsFor(env);
    const dependencies = {
      answerService,
      weatherService,
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
        const result = await processQuestion(message.body, dependencies);
        if (result.disposition === "ack") message.ack(); else message.retry({ delaySeconds: result.delaySeconds });
      } catch {
        message.retry({ delaySeconds: 1 });
        emit({
          event: "queue.message.retry",
          stage: "queue",
          outcome: "retry",
          webhookEventId: message.body.webhookEventId,
          retryDelaySeconds: 1,
          errorType: "unexpected_error",
        });
      }
    }
  },
  async scheduled(_controller, env) {
    const operationId = crypto.randomUUID();
    emit({ event: "cron.cleanup.started", stage: "cron", outcome: "success", operationId });
    try {
      await questionsFor(env).purgeExpired(timestamp());
      emit({ event: "cron.cleanup.completed", stage: "cron", outcome: "success", operationId });
    } catch {
      emit({
        event: "cron.cleanup.failed",
        stage: "cron",
        outcome: "failed",
        operationId,
        errorType: "cron_cleanup_failed",
      });
      throw new Error("scheduled cleanup failed");
    }
  },
} satisfies ExportedHandler<Env, QuestionJob>;
}

const worker = createWorker();

export default worker;
