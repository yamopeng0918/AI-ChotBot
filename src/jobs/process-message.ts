import { AnswerUnavailableError } from "../answers/openrouter";
import type {
  AnswerProviderEvent,
  AnswerProviderFailureReason,
  AnswerService,
} from "../answers/types";
import { classifyIntent } from "../intents/router";
import { LineReplyError, type LineClient } from "../line/client";
import type { GroupSettingsRepository } from "../storage/group-settings";
import type { ClaimResult, QuestionRecord, QuestionsRepository } from "../storage/questions";
import type { MetricRecord, MetricsSink } from "../telemetry/metrics";
import type {
  TelemetryDetail,
  TelemetryErrorType,
  TelemetryEventInput,
  TelemetryLogger,
  TelemetryStage,
} from "../telemetry/logger";
import { WeatherStorageError } from "../weather/openmeteo";
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

function safeElapsedMs(startedAt: Date, now?: () => Date): number {
  try {
    return elapsedMs(startedAt, now);
  } catch {
    return 0;
  }
}

function safeNow(now?: () => Date): Date {
  try {
    return now?.() ?? new Date();
  } catch {
    return new Date();
  }
}

function answerFailure(
  intent: "general" | "weather",
  error: unknown,
): {
  stage: TelemetryStage;
  errorType: TelemetryErrorType;
  detail?: TelemetryDetail;
} {
  if (intent === "weather") {
    if (error instanceof WeatherStorageError) {
      return {
        stage: "storage",
        errorType: "storage_unavailable",
        detail: error.operation === "cache_read" ? "weather_cache_read" : "weather_cache_write",
      };
    }
    return {
      stage: "answer",
      errorType:
        error instanceof DOMException && error.name === "AbortError"
          ? "weather_timeout"
          : "weather_provider_error",
    };
  }
  if (error instanceof AnswerUnavailableError) {
    if (error.reason === "rate_limited") {
      return { stage: "answer", errorType: "ai_rate_limited" };
    }
    if (error.reason === "timeout") {
      return { stage: "answer", errorType: "ai_timeout" };
    }
  }
  return { stage: "answer", errorType: "ai_provider_error" };
}

function aiErrorType(reason: AnswerProviderFailureReason): TelemetryErrorType {
  if (reason === "rate_limited") return "ai_rate_limited";
  if (reason === "timeout") return "ai_timeout";
  return "ai_provider_error";
}

function emit(
  logger: TelemetryLogger | undefined,
  event: TelemetryEventInput,
  now?: () => Date,
): void {
  try {
    logger?.emit({ ...event, timestamp: (now?.() ?? new Date()).toISOString() });
  } catch {}
}

export async function processQuestion(job: QuestionJob, dependencies: ProcessDependencies): Promise<ProcessResult> {
  const startedAt = dependencies.now?.() ?? new Date();
  const metricIntent = classifyIntent(job.text);
  const claimNow = startedAt;

  const retry = (
    stage: TelemetryStage,
    errorType: TelemetryErrorType,
    delaySeconds = 1,
    model?: string | null,
  ): ProcessResult => {
    emit(dependencies.logger, {
      event: "question.retry",
      stage,
      outcome: "retry",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      ...(model !== undefined ? { model } : {}),
      errorType,
      retryDelaySeconds: delaySeconds,
    }, dependencies.now);
    return { disposition: "retry", delaySeconds };
  };

  const release = async (leaseToken: string, model?: string | null): Promise<void> => {
    try {
      await dependencies.questions.release(job.webhookEventId, leaseToken);
    } catch {
      emit(dependencies.logger, {
        event: "storage.release.failed",
        stage: "storage",
        outcome: "failed",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        ...(model !== undefined ? { model } : {}),
        errorType: "storage_unavailable",
      }, dependencies.now);
    }
  };

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
      new Date(claimNow.getTime() + 60_000).toISOString(),
      job.receivedAt,
    );
    emit(dependencies.logger, {
      event: "storage.claim.completed",
      stage: "storage",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
    }, dependencies.now);
  } catch {
    emit(dependencies.logger, {
      event: "storage.claim.failed",
      stage: "storage",
      outcome: "failed",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      errorType: "lease_unavailable",
    }, dependencies.now);
    return retry("storage", "lease_unavailable");
  }

  if (claim.state === "completed") {
    emit(dependencies.logger, {
      event: "question.deduplicated",
      stage: "queue",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      durationMs: safeElapsedMs(startedAt, dependencies.now),
    }, dependencies.now);
    return { disposition: "ack" };
  }

  if (claim.state === "busy") {
    const delaySeconds = Math.max(
      1,
      Math.min(60, Math.ceil((Date.parse(claim.leaseUntil) - claimNow.getTime()) / 1000)),
    );
    return retry("storage", "lease_unavailable", delaySeconds);
  }

  let text: string;
  let model: string | null;
  let status: Outcome;
  const { createdAt, expiresAt, leaseToken } = claim;

  let userKey: string | null;
  try {
    userKey = await dependencies.pseudonymize(job.userId);
  } catch {
    await release(leaseToken);
    return retry("queue", "unexpected_error");
  }

  if (claim.prepared) {
    ({ text, model, status } = claim.prepared);
    emit(dependencies.logger, {
      event: "answer.prepared.reused",
      stage: "answer",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
      detail: "reused_prepared",
    }, dependencies.now);
  } else {
    const selectedService =
      metricIntent === "weather" && dependencies.weatherService
        ? dependencies.weatherService
        : dependencies.answerService;

    let defaultLocation: string | null = null;
    if (metricIntent === "weather" && dependencies.groupSettings) {
      try {
        defaultLocation = await dependencies.groupSettings.getWeatherCity(job.groupId);
      } catch {
        emit(dependencies.logger, {
          event: "weather.settings.failed",
          stage: "storage",
          outcome: "failed",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          errorType: "storage_unavailable",
          detail: "weather_settings",
        }, dependencies.now);
        await release(leaseToken);
        return retry("storage", "storage_unavailable");
      }
    }

    const providerStartedAt = safeNow(dependencies.now);
    const observeProvider = (providerEvent: AnswerProviderEvent): void => {
      const detail = providerEvent.role === "primary" ? "primary_model" : "fallback_model";
      if (providerEvent.type === "attempt.started") {
        emit(dependencies.logger, {
          event: "answer.ai.attempt.started",
          stage: "answer",
          outcome: "success",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model: providerEvent.model,
          detail,
        }, dependencies.now);
        return;
      }
      if (providerEvent.type === "attempt.completed") {
        emit(dependencies.logger, {
          event: "answer.ai.attempt.completed",
          stage: "answer",
          outcome: "success",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model: providerEvent.model,
          detail,
          durationMs: providerEvent.durationMs,
        }, dependencies.now);
        return;
      }
      if (providerEvent.type === "attempt.failed") {
        emit(dependencies.logger, {
          event: "answer.ai.attempt.failed",
          stage: "answer",
          outcome: "failed",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model: providerEvent.model,
          detail,
          errorType: aiErrorType(providerEvent.reason),
          durationMs: providerEvent.durationMs,
        }, dependencies.now);
        return;
      }
      emit(dependencies.logger, {
        event: "answer.ai.fallback.started",
        stage: "answer",
        outcome: "fallback",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model: providerEvent.model,
        detail,
        errorType: aiErrorType(providerEvent.reason),
      }, dependencies.now);
    };
    try {
      const answer = await selectedService.answer({
        question: job.text,
        locale: "zh-TW",
        groupId: job.groupId,
        defaultLocation,
      }, observeProvider);
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
        durationMs: safeElapsedMs(providerStartedAt, dependencies.now),
      }, dependencies.now);
    } catch (error) {
      text = PROVIDER_UNAVAILABLE_TEXT;
      model = null;
      status = "provider_unavailable";
      const classification = answerFailure(metricIntent, error);
      emit(dependencies.logger, {
        event: "answer.failed",
        stage: classification.stage,
        outcome: "fallback",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        errorType: classification.errorType,
        ...(classification.detail !== undefined ? { detail: classification.detail } : {}),
        durationMs: safeElapsedMs(providerStartedAt, dependencies.now),
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
      emit(dependencies.logger, {
        event: "storage.prepare.completed",
        stage: "storage",
        outcome: "success",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model,
      }, dependencies.now);
    } catch {
      emit(dependencies.logger, {
        event: "storage.prepare.failed",
        stage: "storage",
        outcome: "failed",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model,
        errorType: "storage_unavailable",
      }, dependencies.now);
      await release(leaseToken, model);
      return retry("storage", "storage_unavailable", 1, model);
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

    if (!canPushFallback) {
      return retry("line", "line_reply_failed", 1, model);
    }

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
    } catch {
      emit(dependencies.logger, {
        event: "line.push.failed",
        stage: "line",
        outcome: "failed",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model,
        errorType: "line_push_failed",
      }, dependencies.now);
    }

    if (pushCompleted) {
      try {
        await dependencies.questions.complete(record, leaseToken);
        emit(dependencies.logger, {
          event: "storage.complete.completed",
          stage: "storage",
          outcome: "success",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model,
        }, dependencies.now);
        await recordMetricSafe(dependencies.metrics, {
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          status,
          model,
          durationMs: safeElapsedMs(startedAt, dependencies.now),
          detail: "push_fallback",
          createdAt: safeNow(dependencies.now).toISOString(),
        });
        emit(dependencies.logger, {
          event: "question.completed",
          stage: "queue",
          outcome: status === "answered" ? "success" : "fallback",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model,
          durationMs: safeElapsedMs(startedAt, dependencies.now),
        }, dependencies.now);
        return { disposition: "ack", status };
      } catch {
        emit(dependencies.logger, {
          event: "storage.complete.failed",
          stage: "storage",
          outcome: "failed",
          webhookEventId: job.webhookEventId,
          intent: metricIntent,
          model,
          errorType: "storage_unavailable",
        }, dependencies.now);
      }
    }

    try {
      await dependencies.questions.complete({ ...record, status: "reply_failed" }, leaseToken);
      emit(dependencies.logger, {
        event: "storage.complete.completed",
        stage: "storage",
        outcome: "success",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model,
      }, dependencies.now);
    } catch {
      emit(dependencies.logger, {
        event: "storage.complete.failed",
        stage: "storage",
        outcome: "failed",
        webhookEventId: job.webhookEventId,
        intent: metricIntent,
        model,
        errorType: "storage_unavailable",
      }, dependencies.now);
    }

    await recordMetricSafe(dependencies.metrics, {
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      status: "reply_failed",
      model,
      durationMs: safeElapsedMs(startedAt, dependencies.now),
      detail: "reply_and_push_failed",
      createdAt: safeNow(dependencies.now).toISOString(),
    });

    return pushCompleted
      ? retry("storage", "storage_unavailable", 1, model)
      : retry("queue", "line_push_failed", 1, model);
  }

  try {
    await dependencies.questions.complete(record, leaseToken);
    emit(dependencies.logger, {
      event: "storage.complete.completed",
      stage: "storage",
      outcome: "success",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
    }, dependencies.now);
  } catch {
    emit(dependencies.logger, {
      event: "storage.complete.failed",
      stage: "storage",
      outcome: "failed",
      webhookEventId: job.webhookEventId,
      intent: metricIntent,
      model,
      errorType: "storage_unavailable",
    }, dependencies.now);
    return retry("storage", "storage_unavailable", 1, model);
  }

  await recordMetricSafe(dependencies.metrics, {
    webhookEventId: job.webhookEventId,
    intent: metricIntent,
    status,
    model,
    durationMs: safeElapsedMs(startedAt, dependencies.now),
    detail: claim.prepared ? "reused_prepared" : metricIntent,
    createdAt: safeNow(dependencies.now).toISOString(),
  });

  emit(dependencies.logger, {
    event: "question.completed",
    stage: "queue",
    outcome: status === "answered" ? "success" : "fallback",
    webhookEventId: job.webhookEventId,
    intent: metricIntent,
    model,
    durationMs: safeElapsedMs(startedAt, dependencies.now),
  }, dependencies.now);

  return { disposition: "ack", status };
}
