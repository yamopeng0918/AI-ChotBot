# Knowledge and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 LINE bot 上加入受保護的文件／網址匯入、R2 原檔保存、Workers AI 解析與 OCR、Vectorize 檢索、Tavily 即時搜尋及可驗證引用回答。

**Architecture:** 管理 API 只驗證與接受工作，耗時匯入由獨立 Queue consumer 執行。D1 管理具 fencing token 的文件版本與切片，R2 保存原檔，Workers AI 轉檔與產生 embeddings，Vectorize 保存向量；問答協調器先查知識庫，證據不足或問題具時效性時才查 Tavily，最後以結構化 evidence 產生並驗證引用。

**Tech Stack:** TypeScript 5、Cloudflare Workers/Hono、D1、R2、Queues、Workers AI Markdown Conversion、Workers AI BGE-M3 embeddings、Vectorize、Tavily Search API、OpenRouter、Vitest、Miniflare、Wrangler。

## Global Constraints

- 初期最多 50 份文件；單檔最多 10 MB、100 頁。
- 支援 PDF、Word、純文字、JPEG、PNG；OCR 只辨識繁體中文與英文。
- 原始檔保留於私人 R2，不產生公開 URL。
- 網址只接受單篇、公開、無需登入、無 JavaScript 的靜態 HTTPS 頁面。
- 每次問答先查知識庫；只有時效性、明確要求或證據不足才查 Tavily。
- Tavily 不可用時降級成知識庫回答並明確告知無法取得即時結果。
- 引用必須包含文件／頁面名稱及頁碼或段落位置；重要主張必須有支持證據。
- 自有知識與網路衝突時優先較新且較權威來源，並列出差異。
- 管理 API 使用單一 `ADMIN_API_TOKEN`；固定時間比較，Secret 不得寫入程式或 log。
- 檔案、網頁與檢索內容一律視為不可信資料，不得覆蓋 system policy 或觸發工具。
- 50 題品質集的引用支持率至少 90%，Top-5 檢索命中率至少 85%。
- 本計畫不實作管理網頁、整站爬取、動態／會員頁、定期同步、賽事資料或多管理員。

## File Map

- `migrations/0002_knowledge.sql`：文件、切片及匯入工作資料表。
- `src/knowledge/types.ts`：跨 adapter 的文件、切片、evidence、job 型別。
- `src/knowledge/repository.ts`：D1 文件／版本／工作 repository 與 fencing。
- `src/knowledge/admin-auth.ts`：Bearer Token 解析與固定時間驗證。
- `src/knowledge/admin-routes.ts`：管理 API 路由。
- `src/knowledge/file-validation.ts`：大小、MIME、magic bytes 與檔案類型。
- `src/knowledge/url-safety.ts`：HTTPS、DNS、IP、redirect 與回應限制。
- `src/knowledge/storage.ts`：R2 adapter。
- `src/knowledge/converter.ts`：Workers AI Markdown Conversion adapter。
- `src/knowledge/chunker.ts`：Markdown 頁碼／標題／段落切片。
- `src/knowledge/embeddings.ts`：Workers AI embedding adapter。
- `src/knowledge/vector-store.ts`：Vectorize upsert/query/delete adapter。
- `src/knowledge/ingestion.ts`：匯入／重建／刪除工作協調器。
- `src/retrieval/retriever.ts`：知識庫候選檢索與 evidence 組裝。
- `src/retrieval/router.ts`：知識庫優先與網路搜尋原因碼。
- `src/search/tavily.ts`：Tavily adapter 與降級錯誤。
- `src/answers/grounded.ts`：grounded answer prompt、結構化輸出與 citation validator。
- `src/index.ts`：掛載 routes、Queue consumer 與問答依賴。
- `test/knowledge/*`、`test/retrieval/*`、`test/e2e/knowledge-search.test.ts`：測試。
- `test/fixtures/knowledge/*`：小型合成文件與 OCR fixture，不放真實群組資料。
- `docs/setup/knowledge-search.md`：Cloudflare/Tavily provisioning、staging smoke、DLQ 與成本監控。

---

### Task 1: Knowledge schema, bindings, and shared contracts

**Files:**
- Create: `migrations/0002_knowledge.sql`
- Create: `src/knowledge/types.ts`
- Modify: `src/config.ts`
- Modify: `wrangler.jsonc`
- Create: `test/knowledge/migration.test.ts`

**Interfaces:**
- Produces: `DocumentStatus`, `KnowledgeDocument`, `KnowledgeChunk`, `IngestionJob`, `KnowledgeEvidence`, `IngestionJobMessage`.
- Adds Env bindings: `FILES: R2Bucket`, `VECTORIZE: VectorizeIndex`, `AI: Ai`, `INGESTION_QUEUE: Queue<IngestionJobMessage>` and secrets `ADMIN_API_TOKEN`, `TAVILY_API_KEY`.

- [ ] **Step 1: Write the failing Miniflare migration test**

Apply `0001_questions.sql` and `0002_knowledge.sql`, then assert tables `knowledge_documents`, `knowledge_chunks`, and `ingestion_jobs` exist; assert document status and job operation constraints reject invalid values; assert unique `(document_id,index_version,vector_id)` and indexes on status, active version, document ID, lease, and content hash.

- [ ] **Step 2: Run the migration test to verify RED**

Run: `npm.cmd test -- test/knowledge/migration.test.ts`

Expected: FAIL because `0002_knowledge.sql` is missing.

- [ ] **Step 3: Add exact contracts and migration**

```ts
export type DocumentStatus = "pending" | "processing" | "ready" | "failed" | "deleting";
export type IngestionOperation = "ingest" | "reindex" | "delete";
export type IngestionJobMessage = { jobId: string; documentId: string; operation: IngestionOperation };
export type KnowledgeEvidence = {
  id: string; sourceType: "knowledge" | "web"; title: string; url: string | null;
  text: string; pageNumber: number | null; sectionPath: string | null; paragraphIndex: number | null;
  retrievedAt: string; score: number;
};
```

Migration columns and constraints must match design sections 6–7. Existing `questions` schema must remain unchanged.

- [ ] **Step 4: Configure bindings and bounded Queue**

Add R2, Vectorize, Workers AI and `knowledge-ingestion-jobs` producer/consumer plus `knowledge-ingestion-dlq`; use `max_batch_size: 1`, `max_retries: 3`, and no secret values in `wrangler.jsonc`.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- test/knowledge/migration.test.ts`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: exit 0.

```powershell
git add migrations/0002_knowledge.sql src/knowledge/types.ts src/config.ts wrangler.jsonc test/knowledge/migration.test.ts
git commit -m "feat: add knowledge storage contracts"
```

### Task 2: Admin authentication and document metadata API

**Files:**
- Create: `src/knowledge/admin-auth.ts`
- Create: `src/knowledge/repository.ts`
- Create: `src/knowledge/admin-routes.ts`
- Create: `test/knowledge/admin-auth.test.ts`
- Create: `test/knowledge/admin-routes.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `verifyAdminBearer(header: string | undefined, expectedToken: string): Promise<boolean>`.
- Produces: `KnowledgeRepository.listDocuments()`, `getDocument(id)`, `createPendingDocument(input)`, `createJob(input)`, `markDeleting(id)`.
- Produces: Hono routes for list and detail only; mutation routes remain unregistered until their owning tasks implement them.

- [ ] **Step 1: Write failing auth tests**

Cover absent header, wrong scheme, empty token, wrong token of same/different length, exact token, and a spy proving every non-empty comparison performs a full digest comparison rather than early character return.

- [ ] **Step 2: Implement digest-based constant-work verification**

Hash both UTF-8 tokens with SHA-256 and compare all 32 bytes. Return the same `401 { error: { code: "unauthorized", message: "Unauthorized" } }` for all failures.

- [ ] **Step 3: Write failing route/repository tests**

Using Miniflare D1, assert authenticated list/detail responses, `404 document_not_found`, no stack/provider payload, and that unauthenticated requests never query D1. Assert statuses serialize exactly.

- [ ] **Step 4: Implement focused repository and mount routes**

Use parameterized SQL and inject repository through `createWorker` dependencies. Do not register upload, URL ingest, reindex or delete endpoints until their owning tasks provide complete behavior.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- test/knowledge/admin-auth.test.ts test/knowledge/admin-routes.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/admin-auth.ts src/knowledge/repository.ts src/knowledge/admin-routes.ts src/index.ts test/knowledge/admin-auth.test.ts test/knowledge/admin-routes.test.ts
git commit -m "feat: protect knowledge admin API"
```

### Task 3: File validation, R2 storage, and upload enqueue

**Files:**
- Create: `src/knowledge/file-validation.ts`
- Create: `src/knowledge/storage.ts`
- Create: `test/knowledge/file-validation.test.ts`
- Create: `test/knowledge/file-upload.test.ts`
- Modify: `src/knowledge/admin-routes.ts`
- Modify: `src/knowledge/repository.ts`

**Interfaces:**
- Produces: `validateKnowledgeFile(file): Promise<{ kind; mimeType; extension }>`.
- Produces: `KnowledgeObjectStore.putOriginal(key, body, metadata)`, `getOriginal(key)`, `deleteOriginal(key)`.
- Completes: `POST /admin/knowledge/files` returning `202 { documentId, status: "pending" }`.

- [ ] **Step 1: Write failing validator tests**

Fixtures cover PDF `%PDF-`, DOCX ZIP container with required Word entries, UTF-8 text, JPEG SOI, PNG signature, empty file, 10 MB boundary, 10 MB + 1 byte, MIME spoofing, executable bytes, encrypted PDF marker, malformed DOCX and multiple multipart files.

- [ ] **Step 2: Implement bounded validation**

Read only the bytes needed for signatures before accepting. Reject with stable codes: `unsupported_type`, `file_too_large`, `encrypted_document`, `invalid_file`, `single_file_required`.

- [ ] **Step 3: Write failing upload orchestration tests**

Assert order: validate → R2 put → D1 document/job transaction → Queue send. Queue failure must mark the job failed and remove the newly stored object; duplicate request processing must not create a second job. Assert R2 key is UUID-based and does not contain original filename.

- [ ] **Step 4: Implement upload route and adapters**

Store original name only in D1/R2 metadata after sanitizing control characters. Queue message contains IDs only, never file bytes, Token or filename.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- test/knowledge/file-validation.test.ts test/knowledge/file-upload.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/file-validation.ts src/knowledge/storage.ts src/knowledge/admin-routes.ts src/knowledge/repository.ts test/knowledge/file-validation.test.ts test/knowledge/file-upload.test.ts test/fixtures/knowledge
git commit -m "feat: accept knowledge file uploads"
```

### Task 4: Safe static URL ingestion

**Files:**
- Create: `src/knowledge/url-safety.ts`
- Create: `test/knowledge/url-safety.test.ts`
- Create: `test/knowledge/url-ingest.test.ts`
- Modify: `src/knowledge/admin-routes.ts`
- Modify: `src/knowledge/repository.ts`

**Interfaces:**
- Produces: `SafeUrlFetcher.fetchStaticArticle(url): Promise<{ finalUrl; title; html; fetchedAt }>`.
- Completes: `POST /admin/knowledge/urls` returning `202`.

- [ ] **Step 1: Write failing SSRF and redirect tests**

Cover HTTP scheme, credentials in URL, localhost names, IPv4/IPv6 loopback, RFC1918, link-local, CGNAT, multicast, `0.0.0.0`, IPv4-in-IPv6, decimal/hex IP forms, Cloud metadata addresses, DNS returning private IP, public-to-private redirect, redirect loop, more than 3 redirects, response over 2 MB, non-HTML, timeout and safe public HTML.

- [ ] **Step 2: Implement validation for every hop**

Resolve host through an injected resolver, require all returned addresses to be public, connect only after validation, use `redirect: "manual"`, and repeat validation for each redirect. Declare crawl purpose `search`; reject disallowed robots/Content Signals with `source_disallowed`.

- [ ] **Step 3: Write route orchestration tests**

Assert normalized URL and content hash are saved, Queue message contains IDs only, fetch failure creates no document, and the route does not execute page JavaScript or follow article links.

- [ ] **Step 4: Implement URL route**

Store sanitized HTML in private R2 as the immutable source snapshot, then create the same pending document/job flow used by files.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- test/knowledge/url-safety.test.ts test/knowledge/url-ingest.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/url-safety.ts src/knowledge/admin-routes.ts src/knowledge/repository.ts test/knowledge/url-safety.test.ts test/knowledge/url-ingest.test.ts
git commit -m "feat: ingest safe static URLs"
```

### Task 5: Fenced ingestion jobs and version lifecycle

**Files:**
- Modify: `src/knowledge/repository.ts`
- Create: `test/knowledge/ingestion-repository.test.ts`

**Interfaces:**
- Produces: `claimJob(jobId, leaseSeconds): ClaimJobResult`, `renewJob(jobId, token)`, `failJob`, `beginVersion`, `publishVersion`, `completeJob`.
- Every mutation after claim consumes `leaseToken` and throws `StaleIngestionClaimError` unless exactly one row changes.

- [ ] **Step 1: Write real-D1 race tests**

Test first claim, busy claim with remaining delay, expired reclaim, stale renew/fail/publish/complete rejection, immutable job timestamps, retry limit, ready old version remaining active during reindex, and only current owner publishing new version.

- [ ] **Step 2: Implement the lease state machine**

Use a 5-minute lease renewed between conversion, chunking, embedding and vector writes. Store the new `index_version` before work; never change `active_version` until publish.

- [ ] **Step 3: Test idempotent job redelivery**

Completed jobs ack without external calls; failed permanent jobs ack; busy jobs retry at remaining lease; retryable failed jobs can be explicitly requeued with a new job ID.

- [ ] **Step 4: Verify and commit**

Run: `npm.cmd test -- test/knowledge/ingestion-repository.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/repository.ts test/knowledge/ingestion-repository.test.ts
git commit -m "feat: fence knowledge ingestion jobs"
```

### Task 6: Document conversion, OCR quality, and chunking

**Files:**
- Create: `src/knowledge/converter.ts`
- Create: `src/knowledge/chunker.ts`
- Create: `test/knowledge/converter.test.ts`
- Create: `test/knowledge/chunker.test.ts`

**Interfaces:**
- Produces: `DocumentConverter.convert(source): Promise<ConvertedDocument>`.
- Produces: `chunkDocument(converted): KnowledgeChunkDraft[]`.
- `ConvertedDocument` contains pages with exact page numbers, Markdown, OCR flags and quality diagnostics.

- [ ] **Step 1: Write failing converter contract tests**

Fake Workers AI must receive the original blob and bounded timeout. Cover PDF text layer, DOCX, text, image, conversion error, encrypted/over-100-page output, empty/garbled output, Traditional Chinese + English OCR, and provider timeout/429/5xx classification.

- [ ] **Step 2: Implement Workers AI adapter and quality gate**

Use `env.AI.toMarkdown().transform`. Normalize output without inventing pages. Reject low-quality output based on empty ratio, replacement/control-character ratio and missing readable alphanumeric/CJK content; return stable permanent/retryable error classes.

- [ ] **Step 3: Write failing chunker tests**

Assert headings/paragraphs stay together, page boundaries remain traceable, chunks have deterministic IDs/content hashes, overlap is bounded, no empty chunks, and every chunk has page or paragraph position.

- [ ] **Step 4: Implement deterministic chunking**

Target 500–800 tokens with at most 100-token overlap; never combine nonadjacent pages. Strip document instructions only from control flow, not from stored source text.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- test/knowledge/converter.test.ts test/knowledge/chunker.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/converter.ts src/knowledge/chunker.ts test/knowledge/converter.test.ts test/knowledge/chunker.test.ts
git commit -m "feat: convert and chunk knowledge documents"
```

### Task 7: Embeddings, Vectorize, and atomic index publication

**Files:**
- Create: `src/knowledge/embeddings.ts`
- Create: `src/knowledge/vector-store.ts`
- Create: `src/knowledge/ingestion.ts`
- Create: `test/knowledge/embeddings.test.ts`
- Create: `test/knowledge/ingestion.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `EmbeddingService.embed(texts: string[]): Promise<number[][]>` using `@cf/baai/bge-m3`.
- Produces: `KnowledgeVectorStore.upsert/query/deleteVersion/deleteDocument`.
- Produces: `processIngestionJob(message, dependencies): Promise<{ disposition; delaySeconds? }>`.

- [ ] **Step 1: Write failing embedding/vector contract tests**

Assert batching, stable vector dimension, input/output count equality, finite numbers, max input length, timeout, 429/5xx classification, and metadata limited to document/chunk/version fields.

- [ ] **Step 2: Implement adapters**

Reject malformed embedding responses before Vectorize writes. Namespace vector IDs by document/version/chunk.

- [ ] **Step 3: Write failing ingestion orchestration tests**

Assert order: claim → R2 get → convert → chunk → embed → D1 staging chunks → Vectorize upsert → publish. Inject failures at each step; active version must remain unchanged and staging vectors/chunks must be cleaned or safely retryable. Stale worker can perform no publish/delete.

- [ ] **Step 4: Implement ingestion Queue consumer**

Renew lease before each expensive stage. Ack permanent failures after recording safe error; retry temporary failures with bounded delay; completed duplicate ack. Preserve existing LINE Queue consumer by dispatching batches based on Queue binding/entrypoint configuration.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- test/knowledge/embeddings.test.ts test/knowledge/ingestion.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/embeddings.ts src/knowledge/vector-store.ts src/knowledge/ingestion.ts src/index.ts test/knowledge/embeddings.test.ts test/knowledge/ingestion.test.ts
git commit -m "feat: build atomic knowledge indexes"
```

### Task 8: Knowledge retrieval and evidence routing

**Files:**
- Create: `src/retrieval/retriever.ts`
- Create: `src/retrieval/router.ts`
- Create: `test/retrieval/retriever.test.ts`
- Create: `test/retrieval/router.test.ts`

**Interfaces:**
- Produces: `KnowledgeRetriever.retrieve(question, limit): Promise<RetrievalResult>`.
- Produces: `decideRetrievalRoute(input): { searchWeb: boolean; reason: "explicit" | "time_sensitive" | "insufficient_knowledge" | "knowledge_sufficient" }`.

- [ ] **Step 1: Write failing retrieval tests**

Assert query embedding, Vectorize top candidates, D1 join restricted to `ready` active versions, score threshold, overlap dedupe, deterministic order, max evidence count, and no stale/deleting/failed evidence.

- [ ] **Step 2: Implement retriever**

Return `insufficient: true` when evidence count/score/coverage is below configured thresholds. Never return raw Vectorize metadata without D1 authorization.

- [ ] **Step 3: Write failing route tests**

Cover explicit search/latest wording, dates/prices/news/rules/events, ordinary evergreen question with sufficient evidence, no evidence, and malicious document text asking to trigger web search. Only the user question and deterministic signals may affect route.

- [ ] **Step 4: Implement deterministic routing and commit**

Run: `npm.cmd test -- test/retrieval/retriever.test.ts test/retrieval/router.test.ts`

Expected: PASS.

```powershell
git add src/retrieval/retriever.ts src/retrieval/router.ts test/retrieval/retriever.test.ts test/retrieval/router.test.ts
git commit -m "feat: retrieve knowledge evidence"
```

### Task 9: Tavily search and citation-grounded answers

**Files:**
- Create: `src/search/tavily.ts`
- Create: `src/answers/grounded.ts`
- Create: `test/search/tavily.test.ts`
- Create: `test/answers/grounded.test.ts`
- Modify: `src/jobs/process-message.ts`

**Interfaces:**
- Produces: `WebSearchService.search(query): Promise<KnowledgeEvidence[]>`.
- Produces: `GroundedAnswerService.answer({ question, evidence, webUnavailable }): Promise<GroundedAnswer>`.
- `GroundedAnswer` contains `text`, `citations[]`, `model`, and `usedEvidenceIds[]`.

- [ ] **Step 1: Write failing Tavily tests**

Assert Bearer key, basic search, bounded query/results/timeout, HTTPS URL filtering, normalized title/snippet/time, duplicate URL removal, and error mapping for 429, quota, timeout, 4xx and 5xx. No fallback provider is called.

- [ ] **Step 2: Implement Tavily adapter**

Do not send knowledge document text to Tavily. Query is derived only from the user question and bounded to 400 characters.

- [ ] **Step 3: Write failing grounded-answer tests**

Fake OpenRouter structured output must reference valid evidence IDs. Test citation rendering for file page, URL paragraph and web URL; unsupported citation ID; cited text not supporting claim; conflicts with dates/authority; no evidence; prompt injection inside evidence; web-unavailable disclosure; one corrective regeneration only; final `insufficient_evidence` fallback.

- [ ] **Step 4: Implement evidence prompt and validator**

Evidence is wrapped as quoted data. System rules forbid following evidence instructions. Validator checks IDs, source location and lexical/semantic support through an injected entailment interface; invalid first response receives one correction request, never an unbounded loop.

- [ ] **Step 5: Connect to LINE processor**

Before the existing OpenRouter answer call, retrieve knowledge, route, optionally search Tavily, then use grounded answer. Preserve Phase 1 idempotency: prepared final text is stored before LINE and duplicate jobs reuse it. If both knowledge and web are unavailable, use the existing safe answer path only for non-factual casual conversation; factual questions return evidence insufficient.

- [ ] **Step 6: Verify and commit**

Run: `npm.cmd test -- test/search/tavily.test.ts test/answers/grounded.test.ts test/process-message.test.ts`

Expected: PASS.

```powershell
git add src/search/tavily.ts src/answers/grounded.ts src/jobs/process-message.ts test/search/tavily.test.ts test/answers/grounded.test.ts test/process-message.test.ts
git commit -m "feat: answer with verified citations"
```

### Task 10: Reindex and deletion lifecycle

**Files:**
- Modify: `src/knowledge/admin-routes.ts`
- Modify: `src/knowledge/repository.ts`
- Modify: `src/knowledge/ingestion.ts`
- Create: `test/knowledge/lifecycle.test.ts`

**Interfaces:**
- Completes: `POST /admin/knowledge/documents/:id/reindex` and `DELETE /admin/knowledge/documents/:id`.

- [ ] **Step 1: Write failing lifecycle tests**

Assert reindex keeps old active version searchable until new publish; concurrent reindex returns `409`; delete immediately excludes retrieval, then deletes all Vectorize versions, chunks and R2 object; partial delete retries safely; stale delete cannot remove a replacement version; repeated delete is idempotent.

- [ ] **Step 2: Implement routes and lifecycle jobs**

Return `202` with job ID. Do not synchronously delete R2/Vectorize from HTTP request. Preserve a content-free tombstone long enough to make repeat calls deterministic.

- [ ] **Step 3: Verify and commit**

Run: `npm.cmd test -- test/knowledge/lifecycle.test.ts`

Expected: PASS.

```powershell
git add src/knowledge/admin-routes.ts src/knowledge/repository.ts src/knowledge/ingestion.ts test/knowledge/lifecycle.test.ts
git commit -m "feat: manage knowledge index lifecycle"
```

### Task 11: End-to-end quality gate and operations runbook

**Files:**
- Create: `test/e2e/knowledge-search.test.ts`
- Create: `test/quality/knowledge-evaluation.test.ts`
- Create: `test/fixtures/knowledge/evaluation.json`
- Create: `docs/setup/knowledge-search.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Validates complete upload/URL → Queue → conversion → embedding → Vectorize → retrieval → cited LINE answer → reindex/delete contract.

- [ ] **Step 1: Write the failing E2E**

Use Miniflare D1 and behaviorally faithful R2/AI/Vectorize/Tavily/OpenRouter fakes. Assert authenticated upload, background states, prepared index before `ready`, knowledge-first answer, conditional web search, web failure disclosure, citation location, duplicate job idempotency, reindex atomic switch and complete delete.

- [ ] **Step 2: Implement any remaining dependency injection**

Extend `createWorker` only with typed adapter factories needed by the E2E; production defaults continue to resolve Env bindings. Do not add test-only HTTP routes.

- [ ] **Step 3: Add executable quality evaluator**

The fixture schema includes question, expected source/chunk, supported claims and expected abstention. Test computes citation support and Top-5 hit rates and fails below `0.90` and `0.85`. Start with at least 50 deterministic synthetic cases; real curated content is a pre-production operator responsibility documented separately.

- [ ] **Step 4: Write the provisioning/runbook**

Document exact Wrangler commands for R2, Vectorize dimensions/metric, ingestion Queue/DLQ, Workers AI binding, D1 migration, secrets, staging upload/status/query/reindex/delete smoke, robots/Content Signals, DLQ inspection/replay, key rotation, rollback, and monitoring Workers AI neurons, vector dimensions, R2 operations, Tavily credits and backlog.

- [ ] **Step 5: Run final verification**

Run: `npm.cmd test`

Expected: all tests PASS, including 50-case quality gate.

Run: `npm.cmd run typecheck`

Expected: exit 0.

Run: `npm.cmd run deploy -- --dry-run`

Expected: Wrangler builds, lists DB/R2/AI/Vectorize/two Queue bindings, prints `--dry-run: exiting now`, and does not deploy.

- [ ] **Step 6: Commit**

```powershell
git add test/e2e/knowledge-search.test.ts test/quality test/fixtures/knowledge docs/setup/knowledge-search.md README.md package.json
git commit -m "docs: add knowledge search operations gate"
```

## Completion Criteria

- Tasks 1–11 each pass independent spec and quality review.
- Existing Phase 1 LINE tests remain green.
- Full suite, typecheck and Wrangler dry-run pass on the final branch.
- Real D1 migrations execute in Miniflare; no test reimplements SQL semantics.
- Staging verifies real R2, Workers AI, Vectorize, Queue and Tavily bindings before production.
- Citation support ≥90% and Top-5 retrieval hit rate ≥85% on the executable 50-case gate.
- Ineligible/failed/deleting/stale content cannot enter an answer.
- Upload, URL fetch, Queue replay, reindex and delete are idempotent and fenced.
- No Token, raw LINE user ID, full document, prompt or provider payload appears in logs.
