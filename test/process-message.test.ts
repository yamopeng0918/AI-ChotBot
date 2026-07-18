import { describe, expect, it, vi } from "vitest";
import type { QuestionJob } from "../src/jobs/types";
import { processQuestion } from "../src/jobs/process-message";
import worker from "../src/index";
import { LineReplyError } from "../src/line/client";
const job: QuestionJob = { webhookEventId: "event-1", replyToken: "reply-1", groupId: "group-1", userId: "user-1", messageId: "message-1", text: "Where should I run?", timestamp: 1, receivedAt: "2026-07-18T00:00:00.000Z" };
function deps(claim: unknown = { state: "claimed" }) { return { now: () => new Date("2026-07-18T00:00:00.000Z"), answerService: { answer: vi.fn().mockResolvedValue({ text: "Try the riverside.", model: "model" }) }, lineClient: { reply: vi.fn().mockResolvedValue(undefined) }, questions: { claim: vi.fn().mockResolvedValue(claim), prepare: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) }, pseudonymize: vi.fn().mockResolvedValue("user-key") }; }
describe("processQuestion", () => {
  it("claims with a 60-second lease and prepares before LINE delivery", async () => { const d = deps(); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.questions.claim).toHaveBeenCalledWith("event-1", "2026-07-18T00:01:00.000Z"); expect(d.questions.prepare.mock.invocationCallOrder[0]!).toBeLessThan(d.lineClient.reply.mock.invocationCallOrder[0]!); });
  it("returns retry for a concurrent busy claim", async () => { const d = deps({ state: "busy" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("acks a completed duplicate without LLM or LINE calls", async () => { const d = deps({ state: "completed" }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).not.toHaveBeenCalled(); });
  it("resumes expired prepared work without calling the LLM", async () => { const d = deps({ state: "claimed", prepared: { text: "saved", model: "saved-model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).not.toHaveBeenCalled(); expect(d.lineClient.reply).toHaveBeenCalledWith("reply-1", "saved"); });
  it("records reply_failed and retries LINE using the same prepared text", async () => { const d = deps(); d.lineClient.reply.mockRejectedValueOnce(new LineReplyError(503)).mockResolvedValueOnce(undefined); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "retry" }); expect(d.questions.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "reply_failed", answer: "Try the riverside." })); d.questions.claim.mockResolvedValueOnce({ state: "claimed", prepared: { text: "Try the riverside.", model: "model", status: "answered" } }); await expect(processQuestion(job, d)).resolves.toEqual({ disposition: "ack", status: "answered" }); expect(d.answerService.answer).toHaveBeenCalledOnce(); });
});

describe("queue consumer", () => {
  it("acks completed messages and retries busy messages independently", async () => {
    const db = { prepare: (_sql: string) => ({ bind: (id: string) => ({ run: async () => ({ meta: { changes: 0 } }), first: async () => ({ status: id === "done" ? "answered" : "processing" }) }) }) };
    const completed = { body: { ...job, webhookEventId: "done" }, ack: vi.fn(), retry: vi.fn() };
    const busy = { body: { ...job, webhookEventId: "busy" }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [completed, busy] } as never, { DB: db } as never, {} as never);
    expect(completed.ack).toHaveBeenCalledOnce(); expect(completed.retry).not.toHaveBeenCalled();
    expect(busy.retry).toHaveBeenCalledOnce(); expect(busy.ack).not.toHaveBeenCalled();
  });
});
