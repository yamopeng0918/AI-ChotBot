import type { AnswerService } from "../answers/types";
import { LineReplyError, type LineClient } from "../line/client";
import type { ClaimResult, QuestionRecord, QuestionsRepository } from "../storage/questions";
import type { QuestionJob } from "./types";

export const PROVIDER_UNAVAILABLE_TEXT = "目前服務暫時無法使用，請稍後再試。";
type Outcome = "answered" | "provider_unavailable";
export type ProcessResult = { disposition: "ack"; status?: Outcome } | { disposition: "retry" };
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
  try { claim = await dependencies.questions.claim(job.webhookEventId, new Date(now.getTime() + 60_000).toISOString()); }
  catch { return { disposition: "retry" }; }
  if (claim.state === "completed") return { disposition: "ack" };
  if (claim.state === "busy") return { disposition: "retry" };

  let text: string; let model: string | null; let status: Outcome;
  const createdAt = job.receivedAt;
  const expiresAt = new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString();
  let userKey: string | null;
  try { userKey = await dependencies.pseudonymize(job.userId); }
  catch { await dependencies.questions.release(job.webhookEventId); return { disposition: "retry" }; }
  if (claim.prepared) ({ text, model, status } = claim.prepared);
  else {
    try { const answer = await dependencies.answerService.answer({ question: job.text, locale: "zh-TW" }); text = answer.text; model = answer.model; status = "answered"; }
    catch { text = PROVIDER_UNAVAILABLE_TEXT; model = null; status = "provider_unavailable"; }
    const prepared: QuestionRecord = { webhookEventId: job.webhookEventId, userKey, question: job.text, answer: text, status, model, createdAt, expiresAt };
    try { await dependencies.questions.prepare(prepared, status); }
    catch { await dependencies.questions.release(job.webhookEventId); return { disposition: "retry" }; }
  }
  const record: QuestionRecord = { webhookEventId: job.webhookEventId, userKey, question: job.text, answer: text, status, model, createdAt, expiresAt };
  try { await dependencies.lineClient.reply(job.replyToken, text); }
  catch (error) {
    if (error instanceof LineReplyError) { await dependencies.questions.complete({ ...record, status: "reply_failed" }); return { disposition: "retry" }; }
    return { disposition: "retry" };
  }
  try { await dependencies.questions.complete(record); }
  catch { return { disposition: "retry" }; }
  return { disposition: "ack", status };
}
