import { describe, expect, it, vi } from "vitest";
import type { QuestionJob } from "../src/jobs/types";
import { processQuestion } from "../src/jobs/process-message";
import worker from "../src/index";
import { LineReplyError } from "../src/line/client";
const job: QuestionJob = { webhookEventId: "event-1", replyToken: "reply-1", groupId: "group-1", userId: "user-1", messageId: "message-1", text: "Where should I run?", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z" };
const claimed = { state: "claimed", leaseToken: "lease-a", leaseUntil: "2026-07-18T00:01:00.000Z", createdAt: job.receivedAt, expiresAt: "2026-08-17T00:00:00.000Z" };
function deps(claim: unknown = claimed) { return { now: () => new Date("2026-07-18T00:00:00.000Z"), answerService: { answer: vi.fn().mockResolvedValue({ text: "Try the riverside.", model: "model" }) }, lineClient: { reply: vi.fn().mockResolvedValue(undefined), push: vi.fn().mockResolvedValue(undefined) }, questions: { claim: vi.fn().mockResolvedValue(claim), prepare: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) }, pseudonymize: vi.fn().mockResolvedValue("user-key") }; }
describe("processQuestion", () => {
  it("claims with a 60-second lease and prepares before LINE delivery", async () => { const d = deps(); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.questions.claim).toHaveBeenCalledWith("event-1", "2026-07-18T00:01:00.000Z", job.receivedAt); expect(d.questions.prepare).toHaveBeenCalledWith(expect.anything(), "answered", "lease-a"); expect(d.questions.prepare.mock.invocationCallOrder[0]!).toBeLessThan(d.lineClient.reply.mock.invocationCallOrder[0]!); });
  it("returns a bounded delayed retry for a concurrent busy claim", async () => { const d = deps({ state: "busy", leaseUntil: "2026-07-18T00:00:45.000Z" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 45 }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("acks a completed duplicate without LLM or LINE calls", async () => { const d = deps({ state: "completed" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("resumes expired prepared work without calling the LLM", async () => { const d = deps({ ...claimed, leaseToken: "lease-b", prepared: { text: "saved", model: "saved-model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).toHaveBeenCalledWith("reply-1", "saved"); });
  it("does not call LINE when a stale worker loses its fenced prepare", async () => { const d = deps(); d.questions.prepare.mockRejectedValue(new Error("stale claim")); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.lineClient.reply).not.toHaveBeenCalled(); expect(d.questions.release).toHaveBeenCalledWith("event-1", "lease-a"); });
  it("falls back to pushing the group when LINE rejects an expired reply token", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.lineClient.push).toHaveBeenCalledWith(job.groupId, "Try the riverside."); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "answered", answer: "Try the riverside." }), "lease-a"); expect(d.answerService.answer).toHaveBeenCalledOnce(); });
  it("does not push after an uncertain LINE reply failure", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.lineClient.push).not.toHaveBeenCalled(); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "reply_failed" }), "lease-a"); });
  it("does not log provider error payloads", async () => { const d = deps(); const info = vi.spyOn(console, "info").mockImplementation(() => undefined); d.answerService.answer.mockRejectedValueOnce(new Error("sensitive-provider-payload")); await processQuestion(job, d); expect(JSON.stringify(info.mock.calls)).not.toContain("sensitive-provider-payload"); info.mockRestore(); });
  it("records reply_failed and retries when both reply and push fail", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503)); d.lineClient.push.mockRejectedValueOnce(new Error("push down")); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "reply_failed", answer: "Try the riverside." }), "lease-a"); d.questions.claim.mockResolvedValueOnce({ ...claimed, leaseToken: "lease-b", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); expect(d.lineClient.reply).toHaveBeenNthCalledWith(2, job.replyToken, "Try the riverside."); });
  it("reuses the stable replyToken and prepared text after LINE success but completion failure", async () => { const d = deps(); d.questions.complete.mockRejectedValueOnce(new Error("db failed")).mockResolvedValueOnce(undefined); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry", delaySeconds: 1 }); d.questions.claim.mockResolvedValueOnce({ ...claimed, leaseToken: "lease-b", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(400)); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); expect(d.lineClient.reply).toHaveBeenNthCalledWith(1, job.replyToken, "Try the riverside."); expect(d.lineClient.push).toHaveBeenCalledWith(job.groupId, "Try the riverside."); });

  it("retrieves, routes, searches, then grounds before preparing", async () => {
    const d = deps(); const kb = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Run at six.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "now", score: .9 } as const;
    const web = { ...kb, id: "web:1", sourceType: "web", url: "https://example.com" } as const;
    const retriever = { retrieve: vi.fn().mockResolvedValue({ evidence: [kb], insufficient: false, topScore: .9 }) };
    const webSearch = { search: vi.fn().mockResolvedValue([web]) }; const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "Grounded", model: "grounded-model", citations: [], usedEvidenceIds: ["kb"] }) };
    await processQuestion({ ...job, text: "search online for run time" }, { ...d, retriever, webSearch, groundedAnswerService });
    expect(retriever.retrieve).toHaveBeenCalledWith("search online for run time", 8); expect(webSearch.search).toHaveBeenCalledWith("search online for run time");
    expect(groundedAnswerService.answer).toHaveBeenCalledWith({ question: "search online for run time", evidence: [kb, web], webUnavailable: false });
    expect(retriever.retrieve.mock.invocationCallOrder[0]!).toBeLessThan(webSearch.search.mock.invocationCallOrder[0]!);
    expect(webSearch.search.mock.invocationCallOrder[0]!).toBeLessThan(groundedAnswerService.answer.mock.invocationCallOrder[0]!);
    expect(d.questions.prepare).toHaveBeenCalledWith(expect.objectContaining({ answer: "Grounded", model: "grounded-model" }), "answered", "lease-a");
  });

  it("degrades web failure to KB evidence and marks web unavailable", async () => {
    const d = deps(); const kb = { id: "kb", sourceType: "knowledge", title: "Guide", url: null, text: "Run at six.", pageNumber: 1, sectionPath: null, paragraphIndex: null, retrievedAt: "now", score: .9 } as const;
    const groundedAnswerService = { answer: vi.fn().mockResolvedValue({ text: "KB answer", model: "m", citations: [], usedEvidenceIds: ["kb"] }) };
    await processQuestion({ ...job, text: "search online for run time" }, { ...d, retriever: { retrieve: vi.fn().mockResolvedValue({ evidence: [kb], insufficient: false, topScore: .9 }) }, webSearch: { search: vi.fn().mockRejectedValue(new Error("down")) }, groundedAnswerService });
    expect(groundedAnswerService.answer).toHaveBeenCalledWith(expect.objectContaining({ evidence: [kb], webUnavailable: true }));
  });

  it("returns insufficient evidence for factual questions but permits clearly casual conversation", async () => {
    const factual = deps(), casual = deps(); const empty = { retrieve: vi.fn().mockResolvedValue({ evidence: [], insufficient: true, topScore: null }) }; const webDown = { search: vi.fn().mockRejectedValue(new Error("down")) };
    await processQuestion({ ...job, text: "What time does the race start?" }, { ...factual, retriever: empty, webSearch: webDown, groundedAnswerService: { answer: vi.fn() } });
    expect(factual.answerService.answer).not.toHaveBeenCalled(); expect(factual.lineClient.reply).toHaveBeenCalledWith(job.replyToken, expect.stringContaining("enough reliable evidence"));
    await processQuestion({ ...job, text: "hello!" }, { ...casual, retriever: empty, webSearch: webDown, groundedAnswerService: { answer: vi.fn() } });
    expect(casual.answerService.answer).toHaveBeenCalledOnce();
  });

  it("prepared duplicate bypasses retrieval, web search, and grounded generation", async () => {
    const d = deps({ ...claimed, prepared: { text: "saved", model: "saved-model", status: "answered" } }); const retriever = { retrieve: vi.fn() }, webSearch = { search: vi.fn() }, groundedAnswerService = { answer: vi.fn() };
    await processQuestion(job, { ...d, retriever, webSearch, groundedAnswerService });
    expect(retriever.retrieve).not.toHaveBeenCalled(); expect(webSearch.search).not.toHaveBeenCalled(); expect(groundedAnswerService.answer).not.toHaveBeenCalled();
  });
});

describe("queue consumer", () => {
  it("acks completed messages and retries busy messages independently", async () => {
    const db = { prepare: (_sql: string) => ({ bind: (id: string) => ({ run: async () => ({ meta: { changes: 0 } }), first: async () => ({ status: id === "done" ? "answered" : "processing", lease_until: new Date(Date.now() + 60_000).toISOString() }) }) }) };
    const completed = { body: { ...job, webhookEventId: "done" }, ack: vi.fn(), retry: vi.fn() };
    const busy = { body: { ...job, webhookEventId: "busy" }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [completed, busy] } as never, { DB: db } as never, {} as never);
    expect(completed.ack).toHaveBeenCalledOnce(); expect(completed.retry).not.toHaveBeenCalled();
    expect(busy.retry).toHaveBeenCalledOnce(); const delay = busy.retry.mock.calls[0]![0].delaySeconds; expect(delay).toBeGreaterThanOrEqual(59); expect(delay).toBeLessThanOrEqual(60); expect(busy.ack).not.toHaveBeenCalled();
  });
});
