import { describe, expect, test, vi } from "vitest";

import { ClaimedUploadError, finalizeClaimedUpload } from "../../src/knowledge/claimed-upload";

const createdAt = "2026-07-20T00:00:00.000Z";

function setup(options: { previousR2Key?: string | null; complete?: boolean; putFails?: boolean; queueFails?: boolean } = {}) {
  const order: string[] = [];
  const repository = {
    completeUpload: vi.fn(async () => { order.push("complete"); return options.complete ?? true; }),
    failUpload: vi.fn(async () => { order.push("fail"); return true; }),
    clearUploadClaim: vi.fn(async () => { order.push("clear"); return true; }),
  };
  const store = {
    putOriginal: vi.fn(async () => { order.push("put"); if (options.putFails) throw new Error("R2 credential"); }),
    getOriginal: vi.fn(),
    deleteOriginal: vi.fn(async (key: string) => { order.push(`delete:${key}`); }),
  };
  const queue = { send: vi.fn(async () => { order.push("queue"); if (options.queueFails) throw new Error("Queue credential"); }) };
  const input = {
    documentId: "doc", jobId: "job",
    claim: { disposition: "winner" as const, token: "token", r2Key: "doc.md", previousR2Key: options.previousR2Key ?? null },
    blob: new Blob(["# card"], { type: "text/markdown" }), displayName: "card.md", mimeType: "text/markdown", createdAt,
  };
  return { order, repository, store, queue, input };
}

describe("finalizeClaimedUpload", () => {
  test("deletes a prior object, finalizes, enqueues IDs, then clears the winning claim", async () => {
    const d = setup({ previousR2Key: "old.md" });

    await expect(finalizeClaimedUpload(d.input, { repository: d.repository, store: d.store, queue: d.queue as never, now: () => new Date(createdAt) })).resolves.toEqual({ documentId: "doc", status: "pending" });

    expect(d.order).toEqual(["delete:old.md", "put", "complete", "queue", "clear"]);
    expect(d.store.putOriginal).toHaveBeenCalledWith("doc.md", d.input.blob, { originalName: "card.md", mimeType: "text/markdown" });
    expect(d.repository.completeUpload).toHaveBeenCalledWith("doc", { id: "job", documentId: "doc", operation: "ingest", createdAt }, "token", createdAt);
    expect(d.queue.send).toHaveBeenCalledWith({ jobId: "job", documentId: "doc", kind: "ingest" });
  });

  test("resumes an existing pending job without R2 work", async () => {
    const d = setup();

    await expect(finalizeClaimedUpload({ documentId: "doc", jobId: "job", claim: { disposition: "resume_queue" }, createdAt }, { repository: d.repository, store: d.store, queue: d.queue as never })).resolves.toEqual({ documentId: "doc", status: "pending" });

    expect(d.order).toEqual(["queue"]);
  });

  test("returns pending without enqueueing when the finalization fence is lost", async () => {
    const d = setup({ complete: false });

    await expect(finalizeClaimedUpload(d.input, { repository: d.repository, store: d.store, queue: d.queue as never })).resolves.toEqual({ documentId: "doc", status: "pending" });

    expect(d.order).toEqual(["put", "complete", "delete:doc.md"]);
    expect(d.repository.failUpload).not.toHaveBeenCalled();
  });

  test("marks the upload failed and cleans up its object when storage fails", async () => {
    const d = setup({ putFails: true });

    await expect(finalizeClaimedUpload(d.input, { repository: d.repository, store: d.store, queue: d.queue as never, now: () => new Date(createdAt) })).rejects.toMatchObject({ name: "ClaimedUploadError", code: "upload_failed" });

    expect(d.order).toEqual(["put", "fail", "delete:doc.md"]);
    expect(d.repository.failUpload).toHaveBeenCalledWith("doc", "job", "upload_failed", createdAt, "token");
  });

  test("marks the upload failed and cleans up its object when Queue sending fails", async () => {
    const d = setup({ queueFails: true });

    await expect(finalizeClaimedUpload(d.input, { repository: d.repository, store: d.store, queue: d.queue as never, now: () => new Date(createdAt) })).rejects.toEqual(new ClaimedUploadError("queue_unavailable"));

    expect(d.order).toEqual(["put", "complete", "queue", "fail", "delete:doc.md"]);
    expect(d.repository.failUpload).toHaveBeenCalledWith("doc", "job", "queue_send_failed", createdAt, "token");
  });

  test("retries a previously failed coordinator attempt with the same claimed data", async () => {
    const d = setup({ queueFails: true });
    await expect(finalizeClaimedUpload(d.input, { repository: d.repository, store: d.store, queue: d.queue as never })).rejects.toBeInstanceOf(ClaimedUploadError);
    d.queue.send.mockImplementation(async () => { d.order.push("queue"); });

    await expect(finalizeClaimedUpload(d.input, { repository: d.repository, store: d.store, queue: d.queue as never })).resolves.toEqual({ documentId: "doc", status: "pending" });

    expect(d.queue.send).toHaveBeenCalledTimes(2);
  });
});
