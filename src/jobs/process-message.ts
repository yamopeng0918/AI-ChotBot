import type { AnswerService } from "../answers/types";
import { LineReplyError, type LineClient } from "../line/client";
import type { ClaimResult, QuestionRecord, QuestionsRepository } from "../storage/questions";
import type { QuestionJob } from "./types";

export const PROVIDER_UNAVAILABLE_TEXT = "目前服務暫時無法使用，請稍後再試。";
type Outcome = "answered" | "provider_unavailable";
export type ProcessResult = { disposition: "ack"; status?: Outcome } | { disposition: "retry"; delaySeconds: number };
export interface ProcessDependencies {
  answerService: AnswerService;
  lineClient: Pick<LineClient, "reply">;
  questions: Pick<QuestionsRepository, "claim" | "prepare" | "complete" | "release">;
  pseudonymize(userId: string | null): Promise<string | null>;
  now?: () => Date;
}

export async function processQuestion(job: QuestionJob, dependencies: ProcessDependencies): Promise<ProcessResult> {
  const now = dependencies.now?.() ?? new Date();
  let claim: ClaimResult;
  try { claim = await dependencies.questions.claim(job.webhookEventId, new Date(now.getTime() + 60_000).toISOString(), job.receivedAt); }
  catch { return { disposition: "retry", delaySeconds: 1 }; }
  if (claim.state === "completed") return { disposition: "ack" };
  if (claim.state === "busy") return { disposition: "retry", delaySeconds: Math.max(1, Math.min(60, Math.ceil((Date.parse(claim.leaseUntil) - now.getTime()) / 1000))) };

  let text: string; let model: string | null; let status: Outcome;
  const { createdAt, expiresAt, leaseToken } = claim;
  let userKey: string | null;
  try { userKey = await dependencies.pseudonymize(job.userId); }
  catch { try { await dependencies.questions.release(job.webhookEventId, leaseToken); } catch {} return { disposition: "retry", delaySeconds: 1 }; }
  if (claim.prepared) ({ text, model, status } = claim.prepared);
  else {
    try { const answer = await dependencies.answerService.answer({ question: job.text, locale: "zh-TW" }); text = answer.text; model = answer.model; status = "answered"; }
    catch { text = PROVIDER_UNAVAILABLE_TEXT; model = null; status = "provider_unavailable"; }
    const prepared: QuestionRecord = { webhookEventId: job.webhookEventId, userKey, question: job.text, answer: text, status, model, createdAt, expiresAt };
    try { await dependencies.questions.prepare(prepared, status, leaseToken); }
    catch { try { await dependencies.questions.release(job.webhookEventId, leaseToken); } catch {} return { disposition: "retry", delaySeconds: 1 }; }
  }
  const record: QuestionRecord = { webhookEventId: job.webhookEventId, userKey, question: job.text, answer: text, status, model, createdAt, expiresAt };
  try { await dependencies.lineClient.reply(job.replyToken, text); }
  catch (error) {
    // At-least-once retries deliberately reuse the stable LINE replyToken. LINE rejects a token
    // already accepted, preventing a second visible reply; prepared text is never regenerated.
    if (error instanceof LineReplyError) { try { await dependencies.questions.complete({ ...record, status: "reply_failed" }, leaseToken); } catch {} return { disposition: "retry", delaySeconds: 1 }; }
    return { disposition: "retry", delaySeconds: 1 };
  }
  try { await dependencies.questions.complete(record, leaseToken); }
  catch { return { disposition: "retry", delaySeconds: 1 }; }
  return { disposition: "ack", status };
}
