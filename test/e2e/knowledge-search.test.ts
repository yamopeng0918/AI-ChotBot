import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import knowledgeMigration from "../../migrations/0002_knowledge.sql?raw";
import claimMigration from "../../migrations/0003_upload_claim_fencing.sql?raw";
import urlSnapshotMigration from "../../migrations/0004_url_snapshots.sql?raw";
import lifecycleMigration from "../../migrations/0005_ingestion_lifecycle.sql?raw";
import segmentMigration from "../../migrations/0006_knowledge_chunk_segments.sql?raw";
import draftMigration from "../../migrations/0007_knowledge_drafts.sql?raw";
import questionsMigration from "../../migrations/0001_questions.sql?raw";
import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";
import { KnowledgeRepository } from "../../src/knowledge/repository";
import type { ValidatedKnowledgeFile } from "../../src/knowledge/file-validation";
import type { IngestionJobMessage } from "../../src/knowledge/types";
import type { QuestionJob } from "../../src/jobs/types";

const encoder = new TextEncoder();
const now = new Date("2026-07-22T00:00:00.000Z");

async function signature(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return btoa(String.fromCharCode(...bytes));
}

function lineWebhook(overrides: {
  webhookEventId?: string;
  messageId?: string;
  replyToken?: string;
  text?: string;
  groupId?: string;
} = {}) {
  return {
    type: "message",
    webhookEventId: overrides.webhookEventId ?? "event-e2e-1",
    replyToken: overrides.replyToken ?? "reply-e2e-1",
    timestamp: 1_720_000_000_000,
    source: { type: "group", groupId: overrides.groupId ?? "allowed-group", userId: "line-user-1" },
    message: {
      id: overrides.messageId ?? "message-e2e-1",
      type: "text",
      text: overrides.text ?? "@running-bot What should I do after a running injury?",
      mention: { mentionees: [{ isSelf: true }] },
    },
  };
}

async function applyMigrations(db: D1Database): Promise<void> {
  for (const sql of [questionsMigration, knowledgeMigration, claimMigration, urlSnapshotMigration, lifecycleMigration, segmentMigration, draftMigration]) {
    await db.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
  }
}

async function seedReadyDocument(
  db: D1Database,
  input: {
    id: string;
    activeVersion: number;
    nextVersion: number;
    r2Key: string;
    status: "ready" | "deleting";
    updatedAt: string;
  },
): Promise<void> {
  await db.prepare(`INSERT OR REPLACE INTO knowledge_documents
    (id, source_type, display_name, source_url, r2_key, active_version, next_version, status, created_at, updated_at)
    VALUES (?, 'file', ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .bind(input.id, `${input.id}.pdf`, input.r2Key, input.activeVersion, input.nextVersion, input.status, input.updatedAt, input.updatedAt)
    .run();
}

async function seedChunk(
  db: D1Database,
  input: { documentId: string; indexVersion: number; vectorId: string },
): Promise<void> {
  await db.prepare(`INSERT OR REPLACE INTO knowledge_chunks
    (id, document_id, index_version, text, page_number, section_path, paragraph_index, segment_index, vector_id, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.documentId, input.indexVersion, "chunk", 1, null, 0, 0, input.vectorId, "hash", now.toISOString())
    .run();
}

function questionBatch(messages: QuestionJob[]) {
  return { queue: "line-question-jobs", messages: messages.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() })), metadata: {}, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<QuestionJob | IngestionJobMessage>;
}

function ingestionBatch(message: IngestionJobMessage) {
  return { queue: "knowledge-ingestion-jobs", messages: [{ body: message, ack: vi.fn(), retry: vi.fn() }], metadata: {}, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<QuestionJob | IngestionJobMessage>;
}

describe("knowledge search end-to-end harness", () => {
  let dbMf: Miniflare;
  let fetchMf: Miniflare;
  let db: D1Database;

  afterEach(async () => {
    await fetchMf?.dispose();
    await dbMf.dispose();
  });

  beforeEach(async () => {
    dbMf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["DB"] });
    db = await dbMf.getD1Database("DB");
    await applyMigrations(db);
  });

  function fixture() {
    const questionJobs: QuestionJob[] = [];
    const ingestionJobs: IngestionJobMessage[] = [];
    const lineReplies: unknown[] = [];
    const blobs = new Map<string, Blob>();
    const retriever = {
      retrieve: vi.fn(),
    };
    const webSearch = {
      search: vi.fn(),
    };
    const groundedAnswerService = {
      answer: vi.fn(),
    };
    const safeUrlFetcher = {
      fetchStaticArticle: async (url: string) => ({
        finalUrl: url,
        title: "Runner Guide",
        html: "<article><p>Runner guide article</p></article>",
        fetchedAt: now.toISOString(),
      }),
    };
    const validateFile = async (_file: File): Promise<ValidatedKnowledgeFile> => ({
      kind: "pdf",
      mimeType: "application/pdf",
      extension: ".pdf",
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.line.me")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { replyToken?: string; messages?: Array<{ type: string; text?: string }> };
        lineReplies.push(body);
        const prepared = await db.prepare("SELECT status, prepared_status, answer, model FROM questions ORDER BY created_at DESC LIMIT 1").first();
        expect(prepared).toEqual(expect.objectContaining({
          status: "processing",
          prepared_status: "answered",
          answer: expect.any(String),
          model: "grounded-model",
        }));
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected endpoint: ${url}`);
    });
    const objectStore = {
      putOriginal: vi.fn(async (key: string, blob: Blob) => {
        blobs.set(key, blob);
      }),
      getOriginal: vi.fn(async (key: string) => {
        const blob = blobs.get(key);
        return blob ? { blob: async () => blob } : null;
      }),
      deleteOriginal: vi.fn(async (key: string) => {
        blobs.delete(key);
      }),
    };
    const vectors = {
      upsert: vi.fn(async () => undefined),
      deleteIds: vi.fn(async () => undefined),
    };
    const converter = {
      convert: vi.fn(async (source: { documentId: string; indexVersion: number; blob: Blob; kind: "pdf" | "docx" | "text" | "markdown" | "jpeg" | "png"; name: string }) => {
        const markdown = source.kind === "pdf"
          ? "## Metadata\n- Title: Runner Guide\n## Contents\n### Page 1\nRunner guide article\n"
          : await source.blob.text();
        return {
          documentId: source.documentId,
          indexVersion: source.indexVersion,
          kind: source.kind,
          name: source.name,
          tokens: 64,
          pages: source.kind === "pdf"
            ? [{ pageNumber: 1, markdown, ocrApplied: null, diagnostics: { nonWhitespaceCharacters: 32, replacementRatio: 0, controlRatio: 0, hasReadableContent: true, ocrStatus: "unknown" as const } }]
            : [{ pageNumber: null, markdown, ocrApplied: null, diagnostics: { nonWhitespaceCharacters: markdown.replace(/\s/g, "").length, replacementRatio: 0, controlRatio: 0, hasReadableContent: true } }],
        };
      }),
    };
    const embeddings = {
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0))),
    };
    const worker = createWorker({
      fetcher,
      now: () => new Date(now),
      knowledge: new KnowledgeRepository(db) as never,
      objectStore: objectStore as never,
      ingestionQueue: { send: async (message: IngestionJobMessage) => { ingestionJobs.push(message); return undefined as never; } } as unknown as Pick<Queue<IngestionJobMessage>, "send">,
      queue: { send: async (job: QuestionJob) => { questionJobs.push(job); return undefined as never; } } as unknown as Pick<Queue<QuestionJob>, "send">,
      retriever: () => retriever,
      webSearch: () => webSearch,
      groundedAnswerService: () => groundedAnswerService,
      validateFile,
      safeUrlFetcher: () => safeUrlFetcher,
      ingestion: {
        repository: new KnowledgeRepository(db),
        objectStore: objectStore as never,
        converter,
        embeddings,
        vectors: vectors as never,
        now: () => new Date(now),
      },
    });
    let env!: Env;
    fetchMf = new Miniflare({
      modules: true,
      script: `export default { async fetch(request, env) { return env.APP.fetch(request); } }`,
      serviceBindings: {
        APP: async (request: any) => worker.fetch(new Request(request.url, request), env, {} as ExecutionContext),
      },
    });
    env = {
      DB: db,
      ADMIN_API_TOKEN: "admin-secret",
      LINE_CHANNEL_SECRET: "channel-secret",
      LINE_CHANNEL_ACCESS_TOKEN: "line-token",
      LINE_GROUP_ID: "allowed-group",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_MODEL: "grounded-model",
      ANALYTICS_HASH_KEY: "analytics-key-at-least-32-bytes-long",
      MESSAGE_QUEUE: { send: async (job: QuestionJob) => { questionJobs.push(job); return undefined as never; } } as unknown as Queue<QuestionJob>,
      INGESTION_QUEUE: { send: async (message: IngestionJobMessage) => { ingestionJobs.push(message); return undefined as never; } } as unknown as Queue<IngestionJobMessage>,
    } as unknown as Env;

    return {
      worker,
      env,
      fetchMf,
      questionJobs,
      ingestionJobs,
      lineReplies,
      retriever,
      webSearch,
      groundedAnswerService,
      fetcher,
      objectStore,
      vectors,
      safeUrlFetcher,
      validateFile,
      converter,
      embeddings,
    };
  }

  async function deliver(worker: ReturnType<typeof createWorker>, env: Env, webhookEvent: ReturnType<typeof lineWebhook>) {
    const body = JSON.stringify({ events: [webhookEvent] });
    return fetchMf.dispatchFetch("https://worker.test/webhooks/line", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-line-signature": await signature(body, env.LINE_CHANNEL_SECRET),
      },
      body,
    });
  }

  it("uploads a file and a URL through the real admin routes and enqueues ingest jobs", async () => {
    const { worker, env, ingestionJobs, objectStore, converter, embeddings, vectors, fetchMf } = fixture();
    const repository = new KnowledgeRepository(db);

    const fileForm = new FormData();
    fileForm.append("file", new File(["runner guide"], "guide.pdf", { type: "application/pdf" }));
    const fileResponse = await worker.fetch(new Request("https://worker.test/admin/knowledge/files", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret", "Idempotency-Key": "file-key" },
      body: fileForm,
    }), env, {} as ExecutionContext);

    expect(fileResponse.status).toBe(202);
    const fileBody = await fileResponse.json() as { documentId: string; status: string };
    expect(fileBody.status).toBe("pending");

    const urlResponse = await fetchMf.dispatchFetch("https://worker.test/admin/knowledge/urls", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        "Idempotency-Key": "url-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/runner-guide" }),
    });

    expect(urlResponse.status).toBe(202);
    const urlBody = await urlResponse.json() as { documentId: string; status: string };
    expect(urlBody.status).toBe("pending");
    expect(ingestionJobs).toEqual([
      expect.objectContaining({ kind: "ingest", documentId: expect.any(String), jobId: expect.any(String) }),
      expect.objectContaining({ kind: "ingest", documentId: expect.any(String), jobId: expect.any(String) }),
    ]);
    expect(objectStore.putOriginal).toHaveBeenCalledTimes(2);

    for (const job of [...ingestionJobs]) {
      await worker.queue!(ingestionBatch(job), env, {} as ExecutionContext);
    }
    expect(converter.convert).toHaveBeenCalledTimes(2);
    expect(embeddings.embed).toHaveBeenCalledTimes(2);
    expect(vectors.upsert).toHaveBeenCalledTimes(2);
    expect(await repository.getDocument(fileBody.documentId)).toEqual(expect.objectContaining({ status: "ready" }));
    expect(await repository.getDocument(urlBody.documentId)).toEqual(expect.objectContaining({ status: "ready" }));
  });

  it("answers a knowledge-backed group question and ignores duplicate delivery", async () => {
    const { worker, env, questionJobs, lineReplies, retriever, webSearch, groundedAnswerService } = fixture();
    await seedReadyDocument(db, {
      id: "doc-1",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc-1.pdf",
      status: "ready",
      updatedAt: now.toISOString(),
    });
    await seedChunk(db, { documentId: "doc-1", indexVersion: 1, vectorId: "a".repeat(64) });

    const evidence = [{
      id: "kb-1",
      sourceType: "knowledge" as const,
      title: "Runner Guide",
      url: null,
      text: "Reduce mileage and rebuild gradually after injury.",
      pageNumber: 1,
      sectionPath: "Recovery",
      paragraphIndex: null,
      retrievedAt: now.toISOString(),
      score: 0.92,
    }];
    retriever.retrieve.mockResolvedValue({ evidence, insufficient: false, topScore: 0.92 });
    webSearch.search.mockResolvedValue([]);
    groundedAnswerService.answer.mockResolvedValue({
      text: "Reduce mileage and rebuild gradually after injury.\n\nSources:\n[1] Runner Guide ??p. 1 ??Recovery",
      citations: ["[1] Runner Guide ??p. 1 ??Recovery"],
      model: "grounded-model",
      usedEvidenceIds: ["kb-1"],
    });

    const webhook = lineWebhook({ webhookEventId: "event-e2e-knowledge", messageId: "message-knowledge", replyToken: "reply-knowledge" });
    expect((await deliver(worker, env, webhook)).status).toBe(200);
    expect(questionJobs).toHaveLength(1);

    await worker.queue!(questionBatch([questionJobs[0]!] as QuestionJob[]), env, {} as ExecutionContext);
    expect(retriever.retrieve).toHaveBeenCalledWith("@running-bot What should I do after a running injury?", 8);
    expect(webSearch.search).not.toHaveBeenCalled();
    expect(groundedAnswerService.answer).toHaveBeenCalledWith(expect.objectContaining({
      question: "@running-bot What should I do after a running injury?",
      evidence,
      webUnavailable: false,
    }));
    expect(lineReplies).toEqual([{ replyToken: "reply-knowledge", messages: [{ type: "text", text: "Reduce mileage and rebuild gradually after injury.\n\nSources:\n[1] Runner Guide ??p. 1 ??Recovery" }] }]);
    expect((await db.prepare("SELECT webhook_event_id, status, prepared_status, answer, model FROM questions").all()).results).toEqual([
      { webhook_event_id: "event-e2e-knowledge", status: "answered", prepared_status: "answered", answer: "Reduce mileage and rebuild gradually after injury.\n\nSources:\n[1] Runner Guide ??p. 1 ??Recovery", model: "grounded-model" },
    ]);

    expect((await deliver(worker, env, webhook)).status).toBe(200);
    expect(questionJobs).toHaveLength(2);
    await worker.queue!(questionBatch(questionJobs), env, {} as ExecutionContext);
    expect(lineReplies).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM questions").first<{ count: number }>())?.count).toBe(1);
  });

  it("falls back to web search when knowledge is insufficient", async () => {
    const { worker, env, questionJobs, lineReplies, retriever, webSearch, groundedAnswerService } = fixture();
    retriever.retrieve.mockResolvedValue({ evidence: [], insufficient: true, topScore: null });
    webSearch.search.mockResolvedValue([{
      id: "web-1",
      sourceType: "web" as const,
      title: "Running Recovery Guide",
      url: "https://example.gov/running/recovery",
      text: "Reduce training load and rebuild gradually.",
      pageNumber: null,
      sectionPath: null,
      paragraphIndex: 0,
      retrievedAt: now.toISOString(),
      score: 0.4,
    }]);
    groundedAnswerService.answer.mockResolvedValue({
      text: "Reduce training load and rebuild gradually.\n\nSources:\n[1] Running Recovery Guide ??paragraph 1 ??https://example.gov/running/recovery",
      citations: ["[1] Running Recovery Guide ??paragraph 1 ??https://example.gov/running/recovery"],
      model: "grounded-model",
      usedEvidenceIds: ["web-1"],
      validatedClaims: [{ text: "Reduce training load and rebuild gradually.", evidenceIds: ["web-1"] }],
    });

    const webhook = lineWebhook({
      webhookEventId: "event-e2e-web",
      messageId: "message-web",
      replyToken: "reply-web",
      text: "@running-bot How should I return to running after injury?",
    });
    expect((await deliver(worker, env, webhook)).status).toBe(200);
    expect(questionJobs).toHaveLength(1);

    await worker.queue!(questionBatch(questionJobs), env, {} as ExecutionContext);
    expect(retriever.retrieve).toHaveBeenCalledWith("@running-bot How should I return to running after injury?", 8);
    expect(webSearch.search).toHaveBeenCalledWith("@running-bot How should I return to running after injury?");
    expect(groundedAnswerService.answer).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.arrayContaining([expect.objectContaining({ sourceType: "web", title: "Running Recovery Guide" })]),
      webUnavailable: false,
    }));
    expect(lineReplies).toEqual([{ replyToken: "reply-web", messages: [{ type: "text", text: "Reduce training load and rebuild gradually.\n\nSources:\n[1] Running Recovery Guide ??paragraph 1 ??https://example.gov/running/recovery" }] }]);
  });

  it("reviews a validated web draft into knowledge used by the same question", async () => {
    const { worker, env, questionJobs, ingestionJobs, lineReplies, retriever, webSearch, groundedAnswerService } = fixture();
    const webEvidence = {
      id: "web:run", sourceType: "web" as const, title: "Official Running Guide",
      url: "https://example.gov/running/recovery", text: "Reduce training load and rebuild gradually.",
      pageNumber: null, sectionPath: null, paragraphIndex: 0, retrievedAt: now.toISOString(), score: 0.9,
    };
    let retrievalCount = 0;
    retriever.retrieve.mockImplementation(async () => {
      retrievalCount += 1;
      if (retrievalCount === 1) return { evidence: [], insufficient: true, topScore: null };
      const rows = await db.prepare(`SELECT c.vector_id vectorId,c.document_id documentId,c.text,d.display_name displayName
        FROM knowledge_chunks c JOIN knowledge_documents d
          ON d.id=c.document_id AND d.status='ready' AND d.active_version=c.index_version
        ORDER BY c.segment_index`).all<{ vectorId: string; documentId: string; text: string; displayName: string }>();
      if (!rows.results.length) return { evidence: [], insufficient: true, topScore: null };
      return { evidence: rows.results.map((row) => ({
        id: `chunk:${row.vectorId}`, sourceType: "knowledge" as const, title: row.displayName, url: null,
        text: row.text, pageNumber: null, sectionPath: null, paragraphIndex: null,
        retrievedAt: now.toISOString(), score: 0.95,
      })), insufficient: false, topScore: 0.95 };
    });
    webSearch.search.mockResolvedValue([webEvidence]);
    groundedAnswerService.answer.mockImplementation(async ({ evidence }: { evidence: Array<{ id: string; sourceType: string }> }) => {
      const selected = evidence[0]!;
      return selected.sourceType === "web" ? {
        text: "Reduce training load and rebuild gradually.\n\nSources:\n[1] Official Running Guide — https://example.gov/running/recovery",
        citations: ["[1] Official Running Guide — https://example.gov/running/recovery"], model: "grounded-model",
        usedEvidenceIds: [webEvidence.id], validatedClaims: [{ text: "Reduce training load and rebuild gradually.", evidenceIds: [webEvidence.id] }],
      } : {
        text: "Knowledge card says to reduce training load and rebuild gradually.\n\nSources:\n[1] Reviewed recovery card",
        citations: ["[1] Reviewed recovery card"], model: "grounded-model",
        usedEvidenceIds: [selected.id], validatedClaims: [{ text: "Knowledge card says to reduce training load and rebuild gradually.", evidenceIds: [selected.id] }],
      };
    });
    const text = "@running-bot How should I return to running after injury?";
    const first = lineWebhook({ webhookEventId: "event-draft-first", messageId: "message-draft-first", replyToken: "reply-draft-first", text });
    expect((await deliver(worker, env, first)).status).toBe(200);
    await worker.queue!(questionBatch([questionJobs.shift()!]), env, {} as ExecutionContext);

    const pending = await db.prepare("SELECT id,status FROM knowledge_drafts").first<{ id: string; status: string }>();
    expect(pending).toEqual({ id: expect.any(String), status: "pending" });
    const approved = await fetchMf.dispatchFetch(`https://worker.test/admin/knowledge/drafts/${pending!.id}/approve`, {
      method: "POST", headers: { authorization: "Bearer admin-secret" },
    });
    expect(approved.status).toBe(202);
    expect(ingestionJobs).toHaveLength(1);
    await worker.queue!(ingestionBatch(ingestionJobs.shift()!), env, {} as ExecutionContext);
    const reviewed = await db.prepare("SELECT status,document_id documentId,markdown FROM knowledge_drafts WHERE id=?")
      .bind(pending!.id).first<{ status: string; documentId: string; markdown: string }>();
    const document = await db.prepare("SELECT id,status FROM knowledge_documents WHERE id=?")
      .bind(reviewed!.documentId).first<{ id: string; status: string }>();
    const chunk = await db.prepare("SELECT document_id documentId,text FROM knowledge_chunks WHERE document_id=?")
      .bind(reviewed!.documentId).first<{ documentId: string; text: string }>();
    expect(reviewed).toEqual({ status: "approved", documentId: expect.any(String), markdown: expect.any(String) });
    expect(document).toEqual({ id: reviewed!.documentId, status: "ready" });
    expect(chunk?.documentId).toBe(reviewed!.documentId);
    expect(chunk?.text).toContain("Reduce training load and rebuild gradually\\.");
    expect(reviewed!.markdown).toContain(chunk!.text.trim());

    const second = lineWebhook({ webhookEventId: "event-draft-second", messageId: "message-draft-second", replyToken: "reply-draft-second", text });
    expect((await deliver(worker, env, second)).status).toBe(200);
    await worker.queue!(questionBatch([questionJobs.shift()!]), env, {} as ExecutionContext);
    expect(webSearch.search).toHaveBeenCalledTimes(1);
    expect(retriever.retrieve).toHaveBeenCalledTimes(2);
    const secondEvidence = groundedAnswerService.answer.mock.calls[1]?.[0].evidence
      .find((item: { text: string }) => item.text.includes("Reduce training load and rebuild gradually\\."));
    expect(secondEvidence).toMatchObject({ sourceType: "knowledge", text: expect.stringContaining("Reduce training load and rebuild gradually\\.") });
    expect(secondEvidence.id).toMatch(/^chunk:[0-9a-f]{64}$/);
    expect(lineReplies.at(-1)).toEqual({
      replyToken: "reply-draft-second",
      messages: [{ type: "text", text: "Knowledge card says to reduce training load and rebuild gradually.\n\nSources:\n[1] Reviewed recovery card" }],
    });
  });

  it("reindexes through the real worker while keeping the old version searchable until publish", async () => {
    const { worker, env, ingestionJobs, objectStore } = fixture();
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc-lifecycle",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc-lifecycle.pdf",
      status: "ready",
      updatedAt: now.toISOString(),
    });
    await seedChunk(db, { documentId: "doc-lifecycle", indexVersion: 1, vectorId: "a".repeat(64) });

    const reindex = await fetchMf.dispatchFetch("https://worker.test/admin/knowledge/documents/doc-lifecycle/reindex", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(reindex.status).toBe(202);
    const reindexBody = await reindex.json() as { jobId: string; status: string };
    expect(reindexBody).toEqual({ jobId: expect.any(String), status: "pending" });
    expect(ingestionJobs).toEqual([expect.objectContaining({ kind: "reindex", documentId: "doc-lifecycle", jobId: reindexBody.jobId })]);
    expect(await repository.getDocument("doc-lifecycle")).toEqual(expect.objectContaining({ activeVersion: 1, status: "ready" }));
    expect(await repository.authorizeVectorIds(["a".repeat(64)])).toHaveLength(1);

    await objectStore.putOriginal("doc-lifecycle.pdf", new Blob(["## Metadata\n- Title: Runner Guide\n## Contents\n### Page 1\nRunner guide article\n"], { type: "text/plain" }));
    await worker.queue!(ingestionBatch({ jobId: reindexBody.jobId, documentId: "doc-lifecycle", kind: "reindex" }), env, {} as ExecutionContext);
    expect(await repository.getDocument("doc-lifecycle")).toEqual(expect.objectContaining({ activeVersion: 2, status: "ready", r2Key: "doc-lifecycle.pdf" }));
    expect(await repository.authorizeVectorIds(["a".repeat(64)])).toHaveLength(0);
    const vectorIds = await repository.listVectorIds("doc-lifecycle", 2);
    expect(vectorIds).toHaveLength(1);
    expect(await repository.authorizeVectorIds(vectorIds)).toHaveLength(1);
  });

  it("deletes through the real worker and tombstones before cleanup", async () => {
    const { worker, env, vectors, objectStore } = fixture();
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc-delete",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc-delete.pdf",
      status: "ready",
      updatedAt: now.toISOString(),
    });
    await seedChunk(db, { documentId: "doc-delete", indexVersion: 1, vectorId: "a".repeat(64) });

    const del = await fetchMf.dispatchFetch("https://worker.test/admin/knowledge/documents/doc-delete", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(del.status).toBe(202);
    const delBody = await del.json() as { jobId: string; status: string };
    expect(delBody).toEqual({ jobId: expect.any(String), status: "pending" });
    expect(await repository.getDocument("doc-delete")).toEqual(expect.objectContaining({ status: "deleting", activeVersion: 1 }));

    await worker.queue!(ingestionBatch({ jobId: delBody.jobId, documentId: "doc-delete", kind: "delete" }), env, {} as ExecutionContext);

    expect(vectors.deleteIds).toHaveBeenCalledWith(["a".repeat(64)]);
    expect(objectStore.deleteOriginal).toHaveBeenCalledWith("doc-delete.pdf");
    expect(await repository.getDocument("doc-delete")).toEqual(expect.objectContaining({
      status: "deleting",
      activeVersion: null,
      r2Key: "doc-delete.pdf",
      contentHash: null,
      pageCount: null,
    }));
  });

  it("ignores a stale delete job after a replacement version has been published", async () => {
    const { worker, env, vectors, objectStore } = fixture();
    const repository = new KnowledgeRepository(db);
    await seedReadyDocument(db, {
      id: "doc-replacement",
      activeVersion: 1,
      nextVersion: 2,
      r2Key: "doc-replacement.pdf",
      status: "ready",
      updatedAt: now.toISOString(),
    });
    await seedChunk(db, { documentId: "doc-replacement", indexVersion: 1, vectorId: "a".repeat(64) });

    const del = await fetchMf.dispatchFetch("https://worker.test/admin/knowledge/documents/doc-replacement", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-secret" },
    });
    const delBody = await del.json() as { jobId: string };

    await seedReadyDocument(db, {
      id: "doc-replacement",
      activeVersion: 2,
      nextVersion: 3,
      r2Key: "replacement.pdf",
      status: "ready",
      updatedAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await seedChunk(db, { documentId: "doc-replacement", indexVersion: 2, vectorId: "b".repeat(64) });
    await worker.queue!(ingestionBatch({ jobId: delBody.jobId, documentId: "doc-replacement", kind: "delete" }), env, {} as ExecutionContext);

    expect(vectors.deleteIds).not.toHaveBeenCalled();
    expect(objectStore.deleteOriginal).not.toHaveBeenCalled();
    expect(await repository.getDocument("doc-replacement")).toEqual(expect.objectContaining({ activeVersion: 2, r2Key: "replacement.pdf", status: "ready" }));
  });
});
