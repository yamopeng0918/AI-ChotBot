import type { AnswerService } from "../answers/types";
import { INSUFFICIENT_EVIDENCE_TEXT, type GroundedAnswerService } from "../answers/grounded";
import type { KnowledgeEvidence } from "../knowledge/types";
import { LineReplyError, type LineClient } from "../line/client";
import { decideRetrievalRoute } from "../retrieval/router";
import type { KnowledgeRetriever, RetrievalResult } from "../retrieval/retriever";
import type { WebSearchService } from "../search/tavily";
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
  retriever?: Pick<KnowledgeRetriever, "retrieve">;
  webSearch?: WebSearchService;
  groundedAnswerService?: Pick<GroundedAnswerService, "answer">;
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
    try {
      const answer = dependencies.retriever && dependencies.webSearch && dependencies.groundedAnswerService
        ? await orchestratedAnswer(job.text, dependencies)
        : await dependencies.answerService.answer({ question: job.text, locale: "zh-TW" });
      text = answer.text; model = answer.model; status = "answered";
    }
    catch { text = PROVIDER_UNAVAILABLE_TEXT; model = null; status = "provider_unavailable"; }
    const prepared: QuestionRecord = { webhookEventId: job.webhookEventId, userKey, question: job.text, answer: text, status, model, createdAt, expiresAt };
    try { await dependencies.questions.prepare(prepared, status, leaseToken); }
    catch { try { await dependencies.questions.release(job.webhookEventId, leaseToken); } catch {} return { disposition: "retry", delaySeconds: 1 }; }
  }
  const record: QuestionRecord = { webhookEventId: job.webhookEventId, userKey, question: job.text, answer: text, status, model, createdAt, expiresAt };
  try { await dependencies.lineClient.reply(job.replyToken, text); }
  catch (error) {
    // Redelivery keeps the same replyToken and a replyToken succeeds only once, so retries cannot
    // create a second visible reply. See https://developers.line.biz/en/docs/messaging-api/receiving-messages/
    // and https://developers.line.biz/en/reference/messaging-api/#send-reply-message.
    if (error instanceof LineReplyError) { try { await dependencies.questions.complete({ ...record, status: "reply_failed" }, leaseToken); } catch {} return { disposition: "retry", delaySeconds: 1 }; }
    return { disposition: "retry", delaySeconds: 1 };
  }
  try { await dependencies.questions.complete(record, leaseToken); }
  catch { return { disposition: "retry", delaySeconds: 1 }; }
  return { disposition: "ack", status };
}

async function orchestratedAnswer(question: string, dependencies: ProcessDependencies): Promise<{ text: string; model: string | null }> {
  let retrieval: RetrievalResult;
  try { retrieval = await dependencies.retriever!.retrieve(question, 8); }
  catch { retrieval = { evidence: [], insufficient: true, topScore: null }; }
  const route = decideRetrievalRoute({ question, insufficient: retrieval.insufficient, evidenceCount: retrieval.evidence.length, topScore: retrieval.topScore });
  const evidence: KnowledgeEvidence[] = [...retrieval.evidence]; let webUnavailable = false;
  if (route.searchWeb) {
    try { evidence.push(...await dependencies.webSearch!.search(question)); }
    catch { webUnavailable = true; }
  }
  if (evidence.length) return dependencies.groundedAnswerService!.answer({ question, evidence, webUnavailable });
  if (isClearlyCasual(question)) return dependencies.answerService.answer({ question, locale: "zh-TW" });
  return { text: INSUFFICIENT_EVIDENCE_TEXT, model: null };
}
function isClearlyCasual(question: string): boolean {
  return /^(?:hi|hello|hey|thanks|thank you|bye|good\s*(?:morning|afternoon|evening|night)|嗨|哈囉|你好|謝謝|再見)[!.。！ ]*$/i.test(question.trim());
}
