import type { AnswerService } from "../answers/types";
import { classifyIntent } from "../intents/router";
import { LineReplyError, type LineClient } from "../line/client";
import type { GroupSettingsRepository } from "../storage/group-settings";
import type { ClaimResult, QuestionRecord, QuestionsRepository } from "../storage/questions";
import type { MetricRecord, MetricsSink } from "../telemetry/metrics";
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

export async function processQuestion(job: QuestionJob, dependencies: ProcessDependencies): Promise<ProcessResult> {
  const startedAt = dependencies.now?.() ?? new Date();
  const metricIntent = classifyIntent(job.text);
  const now = startedAt;
  let claim: ClaimResult;
  try {
    claim = await dependencies.questions.claim(
      job.webhookEventId,
      new Date(now.getTime() + 60_000).toISOString(),
      job.receivedAt,
    );
  } catch {
    return { disposition: "retry", delaySeconds: 1 };
  }

  if (claim.state === "completed") return { disposition: "ack" };
  if (claim.state === "busy") {
    return {
      disposition: "retry",
      delaySeconds: Math.max(1, Math.min(60, Math.ceil((Date.parse(claim.leaseUntil) - now.getTime()) / 1000))),
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
    } catch {
      text = PROVIDER_UNAVAILABLE_TEXT;
      model = null;
      status = "provider_unavailable";
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
  } catch (error) {
    if (error instanceof LineReplyError) {
      try {
        await dependencies.lineClient.push(job.groupId, text);
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
        return { disposition: "ack", status };
      } catch (pushError) {
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
    return { disposition: "retry", delaySeconds: 1 };
  }

  try {
    await dependencies.questions.complete(record, leaseToken);
  } catch {
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

  return { disposition: "ack", status };
}
