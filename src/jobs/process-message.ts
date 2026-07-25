import { AnswerUnavailableError } from "../answers/openrouter";
import type { AnswerService } from "../answers/types";
import { classifyIntent } from "../intents/router";
import { LineReplyError, type LineClient } from "../line/client";
import type { GroupSettingsRepository } from "../storage/group-settings";
import type { ClaimResult, QuestionRecord, QuestionsRepository } from "../storage/questions";
import type { MetricRecord, MetricsSink } from "../telemetry/metrics";
import type { TelemetryEvent, TelemetryLogger } from "../telemetry/logger";
import type { QuestionJob } from "./types";

export const PROVIDER_UNAVAILABLE_TEXT = "目前服務暫時無法使用，請稍後再試。";

type Outcome = "answered" | "provider_unavailable";
export type ProcessResult = { disposition: "ack"; status?: Outcome } | { disposition: "retry"; delaySeconds: number };

export interface ProcessDependencies {
  answerService: AnswerService;
  weatherService?: AnswerService;
  lineClient: Pick<LineClient, "reply" | "push">;
  questions: Pick<QuestionsRepository, "claim" | "prepare" | "complete" | "release">;
  groupSettings?: Pick<GroupSettingsRepository, "getWeatherCity">;
  metrics?: MetricsSink;
  logger?: TelemetryLogger;
  pseudonymize(userId: string | null): Promise<string | null>;
  now?: () => Date;
}

async function recordMetricSafe(metrics: MetricsSink | undefined, metric: MetricRecord): Promise<void> {
  if (!metrics) return;
  try {
    await metrics.record(metric);
  } catch {}
}

function elapsedMs(startedAt: Date, now?: () => Date): number {
  return Math.max(0, (now?.() ?? new Date()).getTime() - startedAt.getTime());
}

function answerErrorType(
  intent: "general" | "weather",
  error: unknown,
): TelemetryEvent["errorType"] {
  if (intent === "weather") {
    return error instanceof DOMException && error.name === "AbortError"
      ? "weather_timeout"
      : "weather_provider_error";
  }
  if (error instanceof AnswerUnavailableError) {
    if (error.reason === "rate_limited") return "ai_rate_limited";
    if (error.reason === "timeout") return "ai_timeout";
  }
  return "ai_provider_error";
}

function emit(
  logger: TelemetryLogger | undefined,
  event: Omit<TelemetryEvent, "timestamp">,
  now?: () => Date,
): void {
  try {
    logger?.emit({ ...event, timestamp: (now?.() ?? new Date()).toISOString() });
  } catch {}
}

export async function processQuestion(job: QuestionJob, dependencies: ProcessDependencies): Promise<ProcessResult> {
  const startedAt = dependencies.now?.() ?? new Date();
  const metricIntent = classifyIntent(job.text);
  const now = startedAt;
  emit(dependencies.logger, {
    event: "question.started",
    stage: "queue",
    outcome: "success",
    webhookEventId: job.webhookEventId,
    intent: metricIntent,
  }, dependencies.now);
  let claim: ClaimResult;
  try {
    claim = await dependencies.questions.claim(
      job.webhookEventId,
      new Date(now.getTime() + 60_000).toISOString(),
      job.receivedAt,
    );
  } catch {
    emit(dependencies.logger, {
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      errorType: "lease_unavailable",
      retryDelaySeconds: 1,
    }, dependencies.now);
    return { disposition: "retry", delaySeconds: 1 };
  }

  if (claim.state === "completed") {
    emit(dependencies.logger, {
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      durationMs: elapsedMs(startedAt, dependencies.now),
    }, dependencies.now);
    return { disposition: "ack" };
  }
  if (claim.state === "busy") {
    const delaySeconds = Math.max(1, Math.min(60, Math.ceil((Date.parse(claim.leaseUntil) - now.getTime()) / 1000)));
    emit(dependencies.logger, {
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      errorType: "lease_unavailable",
      retryDelaySeconds: delaySeconds,
    }, dependencies.now);
    return {
      disposition: "retry",
      delaySeconds,
    };
  }

  let text: string;
  let model: string | null;
  let status: Outcome;
  const { createdAt, expiresAt, leaseToken } = claim;

  let userKey: string | null;
  try {
    userKey = await dependencies.pseudonymize(job.userId);
  } catch {
    try {
      await dependencies.questions.release(job.webhookEventId, leaseToken);
    } catch {}
    emit(dependencies.logger, {
      event: "question.retry",
      stage: "queue",
      outcome: "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      errorType: "unexpected_error",
      retryDelaySeconds: 1,
    }, dependencies.now);
    return { disposition: "retry", delaySeconds: 1 };
  }

  if (claim.prepared) {
    ({ text, model, status } = claim.prepared);
  } else {
    const selectedService =
      metricIntent === "weather" && dependencies.weatherService
        ? dependencies.weatherService
        : dependencies.answerService;
    const defaultLocation =
      metricIntent === "weather" && dependencies.groupSettings
        ? await dependencies.groupSettings.getWeatherCity(job.groupId)
        : null;

    try {
      const answer = await selectedService.answer({
        question: job.text,
        locale: "zh-TW",
        groupId: job.groupId,
        defaultLocation,
      });
      text = answer.text;
      model = answer.model;
      status = "answered";
      emit(dependencies.logger, {
        event: "answer.completed",
        stage: "answer",
        outcome: "success",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model: answer.model,
      }, dependencies.now);
    } catch (error) {
      text = PROVIDER_UNAVAILABLE_TEXT;
      model = null;
      status = "provider_unavailable";
      emit(dependencies.logger, {
        event: "answer.failed",
        stage: "answer",
        outcome: "fallback",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        errorType: answerErrorType(metricIntent, error),
      }, dependencies.now);
    }

    const prepared: QuestionRecord = {
      webhookEventId: job.webhookEventId,
      userKey,
      question: job.text,
      answer: text,
      status,
      model,
      createdAt,
      expiresAt,
    };

    try {
      await dependencies.questions.prepare(prepared, status, leaseToken);
    } catch {
      try {
        await dependencies.questions.release(job.webhookEventId, leaseToken);
      } catch {}
      emit(dependencies.logger, {
        event: "question.retry",
        stage: "storage",
        outcome: "retry",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model,
        errorType: "storage_unavailable",
        retryDelaySeconds: 1,
      }, dependencies.now);
      return { disposition: "retry", delaySeconds: 1 };
    }
  }

  const record: QuestionRecord = {
    webhookEventId: job.webhookEventId,
    userKey,
    question: job.text,
    answer: text,
    status,
    model,
    createdAt,
    expiresAt,
  };

  try {
    await dependencies.lineClient.reply(job.replyToken, text);
    emit(dependencies.logger, {
      event: "line.reply.completed",
      stage: "line",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
    }, dependencies.now);
  } catch (error) {
    const canPushFallback = error instanceof LineReplyError;
    emit(dependencies.logger, {
      event: "line.reply.failed",
      stage: "line",
      outcome: canPushFallback ? "fallback" : "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
      errorType: "line_reply_failed",
    }, dependencies.now);
    if (canPushFallback) {
      let pushCompleted = false;
      try {
        await dependencies.lineClient.push(job.groupId, text);
        pushCompleted = true;
        emit(dependencies.logger, {
          event: "line.push.completed",
          stage: "line",
          outcome: "success",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model,
        }, dependencies.now);
        await dependencies.questions.complete(record, leaseToken);
        await recordMetricSafe(dependencies.metrics, {
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          status,
          model,
          durationMs: elapsedMs(startedAt, dependencies.now),
          detail: "push_fallback",
          createdAt: new Date().toISOString(),
        });
        emit(dependencies.logger, {
          event: "question.completed",
          stage: "queue",
          outcome: status === "answered" ? "success" : "fallback",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model,
          durationMs: elapsedMs(startedAt, dependencies.now),
        }, dependencies.now);
        return { disposition: "ack", status };
      } catch (pushError) {
        emit(dependencies.logger, pushCompleted
          ? {
              event: "question.retry",
              stage: "storage",
              outcome: "retry",
              webhookEventId: job.webhookEventId,
              intent: metricIntent,
              model,
              errorType: "storage_unavailable",
              retryDelaySeconds: 1,
            }
          : {
              event: "line.push.failed",
              stage: "line",
              outcome: "failed",
              webhookEventId: job.webhookEventId,
              intent: metricIntent,
              model,
              errorType: "line_push_failed",
            }, dependencies.now);
        console.info("question:push-error", job.webhookEventId, pushError instanceof Error ? pushError.message : String(pushError));
        try {
          await dependencies.questions.complete({ ...record, status: "reply_failed" }, leaseToken);
        } catch {}
        await recordMetricSafe(dependencies.metrics, {
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          status: "reply_failed",
          model,
          durationMs: elapsedMs(startedAt, dependencies.now),
          detail: "reply_and_push_failed",
          createdAt: new Date().toISOString(),
        });
        return { disposition: "retry", delaySeconds: 1 };
      }
    }
    emit(dependencies.logger, {
      event: "question.retry",
      stage: "line",
      outcome: "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
      errorType: "line_reply_failed",
      retryDelaySeconds: 1,
    }, dependencies.now);
    return { disposition: "retry", delaySeconds: 1 };
  }

  try {
    await dependencies.questions.complete(record, leaseToken);
  } catch {
    emit(dependencies.logger, {
      event: "question.retry",
      stage: "storage",
      outcome: "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
      errorType: "storage_unavailable",
      retryDelaySeconds: 1,
    }, dependencies.now);
    return { disposition: "retry", delaySeconds: 1 };
  }

  await recordMetricSafe(dependencies.metrics, {
    webhookEventId: job.webhookEventId,
    intent: metricIntent,
    status,
    model,
    durationMs: elapsedMs(startedAt, dependencies.now),
    detail: claim.prepared ? "reused_prepared" : metricIntent,
    createdAt: new Date().toISOString(),
  });

  emit(dependencies.logger, {
    event: "question.completed",
    stage: "queue",
    outcome: status === "answered" ? "success" : "fallback",
    webhookEventId: job.webhookEventId,
    intent: metricIntent,
    model,
    durationMs: elapsedMs(startedAt, dependencies.now),
  }, dependencies.now);

  return { disposition: "ack", status };
}
