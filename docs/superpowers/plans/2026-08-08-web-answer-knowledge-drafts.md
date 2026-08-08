# Web Answer Knowledge Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn validated web-grounded running answers into deduplicated Traditional Chinese knowledge drafts that an authenticated administrator can approve into the existing ingestion pipeline.

**Architecture:** Keep weather, administration, greetings, and knowledge-first routing unchanged. Add an isolated D1 draft repository and deterministic card builder; only validated answers that actually used HTTPS web evidence create pending drafts. Approval uses a shared claimed-upload coordinator to write generated Markdown to R2 and enqueue the existing ingestion job.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers/Hono, D1, R2, Queues, Vectorize, Workers AI, Tavily, Vitest 4, Miniflare, Wrangler 4.

## Global Constraints

- Preserve the dedicated weather flow, group administration commands, casual greetings, LINE delivery, and knowledge-first retrieval behavior.
- Search Tavily only when selected by the existing retrieval route.
- Create a draft only after all existing evidence-ID, citation-location, conflict, and entailment validation passes and at least one used HTTPS web source exists.
- Never automatically publish an unreviewed draft.
- Do not store LINE IDs, user keys, reply tokens, raw webhook payloads, full source articles, unused snippets, prompts, answers, Authorization headers, or secrets in logs or telemetry.
- Do not add a Queue, Workflow, dependency, or required Secret.
- Use `ADMIN_API_TOKEN` for every draft management endpoint.
- A draft write failure must not change an otherwise valid LINE response.
- Repeated creation and approval must be idempotent.

---

## File Structure

- Create `migrations/0007_knowledge_drafts.sql`: draft state, provenance, dedupe, and expiry constraints.
- Create `src/knowledge/drafts.ts`: draft types, deterministic repository operations, and cleanup.
- Create `src/knowledge/draft-builder.ts`: pure validated-answer-to-Markdown transformation and dedupe input.
- Create `src/knowledge/claimed-upload.ts`: shared post-claim R2/finalize/Queue coordinator.
- Create `src/knowledge/draft-routes.ts`: authenticated list/detail/approve/reject endpoints.
- Modify `src/answers/grounded.ts`: expose validated claims without weakening validation.
- Modify `src/jobs/process-message.ts`: best-effort draft creation after a validated web answer.
- Modify `src/knowledge/admin-routes.ts`: reuse the shared claimed-upload coordinator.
- Modify `src/index.ts`: assemble draft dependencies, register routes, and schedule expiry.
- Modify `docs/setup/knowledge-search.md`: document review and production smoke operations.
- Add focused tests under `test/knowledge/` and extend grounded, process-message, worker-dependency, and knowledge E2E suites.

### Task 1: Add the isolated D1 draft repository

**Files:**
- Create: `migrations/0007_knowledge_drafts.sql`
- Create: `src/knowledge/drafts.ts`
- Create: `test/knowledge/drafts.test.ts`
- Modify: `test/migrations.test.ts`

**Interfaces:**
- Produces: `KnowledgeDraftStatus`, `KnowledgeDraftSource`, `KnowledgeDraft`, `CreateKnowledgeDraftInput`.
- Produces: `KnowledgeDraftRepository.createOrRefresh(input)`, `list(status, limit)`, `get(id)`, `approve(id, documentId, now)`, `reject(id, now)`, and `purgeExpired(now)`.
- Consumes: only a `D1Database`; no later task interfaces.

- [ ] **Step 1: Write the failing migration and repository tests**

Add a migration assertion and repository cases using real Miniflare D1:

```ts
const source = { title: "World Athletics", url: "https://worldathletics.org/guide", retrievedAt: "2026-08-08T00:00:00.000Z" };
const input = { id: "draft-1", topic: "跑步前暖身", markdown: "# 跑步前暖身", sources: [source], dedupeKey: "dedupe-1", createdAt: "2026-08-08T00:00:00.000Z", expiresAt: "2026-11-06T00:00:00.000Z" };

expect(await repository.createOrRefresh(input)).toMatchObject({ id: "draft-1", status: "pending" });
expect(await repository.createOrRefresh({ ...input, id: "draft-2", createdAt: "2026-08-09T00:00:00.000Z" })).toMatchObject({ id: "draft-1" });
expect(await repository.list("pending", 20)).toHaveLength(1);
expect(await repository.reject("draft-1", "2026-08-10T00:00:00.000Z")).toBe("rejected");
expect(await repository.approve("draft-1", "doc-1", "2026-08-10T00:00:00.000Z")).toBe("conflict");
```

Assert database constraints reject an unknown status, duplicate `dedupe_key`, invalid `sources_json`, and an approved row without `document_id`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm.cmd test -- test/migrations.test.ts test/knowledge/drafts.test.ts`

Expected: FAIL because migration `0007_knowledge_drafts.sql` and `KnowledgeDraftRepository` do not exist.

- [ ] **Step 3: Add the migration and typed repository**

Create the table and indexes:

```sql
CREATE TABLE knowledge_drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
  markdown TEXT NOT NULL CHECK (length(markdown) BETWEEN 1 AND 65536),
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array'),
  dedupe_key TEXT NOT NULL UNIQUE,
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK ((status = 'approved' AND document_id IS NOT NULL AND reviewed_at IS NOT NULL) OR status != 'approved'),
  CHECK ((status = 'rejected' AND reviewed_at IS NOT NULL) OR status != 'rejected')
);
CREATE INDEX idx_knowledge_drafts_status_updated ON knowledge_drafts(status, updated_at DESC);
CREATE INDEX idx_knowledge_drafts_expiry ON knowledge_drafts(status, expires_at);
```

Implement strict row decoding in `drafts.ts`; reject malformed JSON or non-HTTPS sources rather than returning partial data. `createOrRefresh` must use `INSERT ... ON CONFLICT(dedupe_key) DO UPDATE` only when the existing row is pending, preserving its ID and original `created_at`. Clamp list limits to `1..100`. `reject` sets `expires_at` to exactly 30 days after the supplied `now`; `purgeExpired` first rejects expired pending rows, then deletes expired rejected rows and approved rows whose referenced knowledge document no longer exists in one D1 batch.

- [ ] **Step 4: Run focused GREEN**

Run: `npm.cmd test -- test/migrations.test.ts test/knowledge/drafts.test.ts`

Expected: both files PASS, including transition, decoding, dedupe, limit, and expiry cases.

- [ ] **Step 5: Commit**

```powershell
git add migrations/0007_knowledge_drafts.sql src/knowledge/drafts.ts test/migrations.test.ts test/knowledge/drafts.test.ts
git commit -m "feat: add reviewed knowledge draft storage"
```

### Task 2: Build cards only from validated web claims

**Files:**
- Modify: `src/answers/grounded.ts`
- Modify: `test/answers/grounded.test.ts`
- Create: `src/knowledge/draft-builder.ts`
- Create: `test/knowledge/draft-builder.test.ts`

**Interfaces:**
- Produces: exported `GroundedClaim = { text: string; evidenceIds: string[] }` and `GroundedAnswer.validatedClaims`.
- Produces: `buildKnowledgeDraft(answer, evidence, now): Promise<BuiltKnowledgeDraft | null>`.
- Consumes: `KnowledgeEvidence` and the draft source/input types from Task 1.

- [ ] **Step 1: Write failing grounded-result and builder tests**

Prove successful validation exposes claims while fallback exposes none. Then add:

```ts
const built = await buildKnowledgeDraft({
  text: "跑前應循序暖身。\n\nSources:\n[1] Official — https://example.gov/run",
  citations: ["[1] Official — https://example.gov/run"],
  model: "provider/model",
  usedEvidenceIds: ["web:1"],
  validatedClaims: [{ text: "跑前應循序暖身。", evidenceIds: ["web:1"] }],
}, [webEvidence], () => new Date("2026-08-08T00:00:00.000Z"));

expect(built).toMatchObject({ topic: "跑前應循序暖身。", sources: [{ url: "https://example.gov/run" }] });
expect(built?.markdown).toContain("## 重點整理");
expect(built?.markdown).not.toContain("unused snippet");
```

Cover: no used web source returns `null`; knowledge-only IDs return `null`; malformed/non-HTTPS sources return `null`; only used IDs appear; topic is bounded to 120 Unicode code points; input order does not alter the dedupe key; the card contains fixed context/safety text and no raw question/user data.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/answers/grounded.test.ts test/knowledge/draft-builder.test.ts`

Expected: FAIL because validated claims and the builder are missing.

- [ ] **Step 3: Expose claims and implement the pure builder**

Change the public result without changing prompt validation:

```ts
export type GroundedClaim = { text: string; evidenceIds: string[] };
export type GroundedAnswer = {
  text: string; citations: string[]; model: string | null;
  usedEvidenceIds: string[]; validatedClaims: GroundedClaim[];
};
```

`render` copies the already validated claims; `fallback` returns `validatedClaims: []`. In `draft-builder.ts`, select web evidence only through `usedEvidenceIds`, canonicalize and sort HTTPS URLs, derive the topic from the first validated claim, render a fixed Markdown template, compute SHA-256 over `normalizedTopic + "\n" + sortedUrls.join("\n")`, and derive a stable UUID from that hash. Never accept the rendered `Sources:` block as evidence input.

- [ ] **Step 4: Run GREEN and regression search**

Run: `npm.cmd test -- test/answers/grounded.test.ts test/knowledge/draft-builder.test.ts test/process-message.test.ts test/worker-dependencies.test.ts`

Expected: PASS after updating exact expected `GroundedAnswer` objects with `validatedClaims`.

- [ ] **Step 5: Commit**

```powershell
git add src/answers/grounded.ts src/knowledge/draft-builder.ts test/answers/grounded.test.ts test/knowledge/draft-builder.test.ts test/process-message.test.ts test/worker-dependencies.test.ts
git commit -m "feat: build cards from validated web claims"
```

### Task 3: Create drafts best-effort from the question flow

**Files:**
- Modify: `src/jobs/process-message.ts`
- Modify: `src/index.ts`
- Modify: `test/process-message.test.ts`
- Modify: `test/worker-dependencies.test.ts`

**Interfaces:**
- Consumes: `buildKnowledgeDraft` and `KnowledgeDraftRepository.createOrRefresh`.
- Produces: optional `ProcessDependencies.knowledgeDrafts.createOrRefresh(input)` injection.
- Preserves: prepared-answer and LINE-delivery idempotency.

- [ ] **Step 1: Write failing orchestration tests**

Add cases proving:

```ts
await processQuestion(webQuestion, { ...dependencies, retriever, webSearch, groundedAnswerService, knowledgeDrafts });
expect(knowledgeDrafts.createOrRefresh).toHaveBeenCalledOnce();
expect(knowledgeDrafts.createOrRefresh).toHaveBeenCalledWith(expect.objectContaining({
  topic: "跑前應循序暖身。", sources: [expect.objectContaining({ url: "https://example.gov/run" })],
}));
```

Also assert no draft for sufficient knowledge, weather, admin/casual routing, web failure, fallback answer, knowledge-only used IDs, and completed/prepared retries. Make `createOrRefresh` reject and prove LINE reply and question completion still succeed. Assert the repository never receives `groupId`, `userId`, `userKey`, `replyToken`, or the original question.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/process-message.test.ts test/worker-dependencies.test.ts`

Expected: FAIL because the dependency and draft side effect do not exist.

- [ ] **Step 3: Return orchestration context and write best-effort draft**

Change the internal answer helper to return both result and evidence without changing the prepared answer contract:

```ts
type OrchestratedAnswer = { answer: GroundedAnswer | { text: string; model: string | null }; evidence: KnowledgeEvidence[] };
```

After a newly generated grounded answer is selected, call `buildKnowledgeDraft`; if it returns a value, `await knowledgeDrafts.createOrRefresh(built)` inside its own `try/catch`. Emit only `{ event: "knowledge_draft.create", outcome, sourceCount, errorType }`. Do not run this block for reused prepared work. Wire `new KnowledgeDraftRepository(env.DB)` in `src/index.ts` only when knowledge answering is enabled.

- [ ] **Step 4: Run GREEN**

Run: `npm.cmd test -- test/process-message.test.ts test/worker-dependencies.test.ts test/answers/grounded.test.ts`

Expected: PASS with unchanged weather, casual, storage fencing, reply/push, and retry assertions.

- [ ] **Step 5: Commit**

```powershell
git add src/jobs/process-message.ts src/index.ts test/process-message.test.ts test/worker-dependencies.test.ts
git commit -m "feat: capture validated web answer drafts"
```

### Task 4: Extract a shared claimed-upload coordinator

**Files:**
- Create: `src/knowledge/claimed-upload.ts`
- Create: `test/knowledge/claimed-upload.test.ts`
- Modify: `src/knowledge/admin-routes.ts`
- Modify: `test/knowledge/file-upload.test.ts`
- Modify: `test/knowledge/url-ingest.test.ts`

**Interfaces:**
- Produces: `finalizeClaimedUpload(input, dependencies): Promise<{ documentId: string; status: "pending" }>`.
- Produces: `ClaimedUploadError` with only `queue_unavailable` or `upload_failed`.
- Consumes: an existing winning/resume upload claim, `KnowledgeObjectStore`, `KnowledgeAdminRepository`, and ingestion Queue.

- [ ] **Step 1: Write failing coordinator contract tests**

Cover winner success, previous R2 deletion, `resume_queue`, duplicate/busy response, finalize fencing loss, R2 failure cleanup, Queue failure marking, and retry. A representative success assertion:

```ts
await expect(finalizeClaimedUpload({
  documentId: "doc", jobId: "job", claim: { disposition: "winner", token: "token", r2Key: "doc.md", previousR2Key: null },
  blob: new Blob(["# card"], { type: "text/markdown" }), displayName: "card.md", mimeType: "text/markdown", createdAt,
}, dependencies)).resolves.toEqual({ documentId: "doc", status: "pending" });
expect(queue.send).toHaveBeenCalledWith({ jobId: "job", documentId: "doc", kind: "ingest" });
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/knowledge/claimed-upload.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Move the existing post-claim coordination into the helper**

The helper must preserve exact current ordering: optionally delete the previous object, put the new object, `completeUpload`, enqueue, then `clearUploadClaim`. On storage/finalization failure, call `failUpload` and delete the just-written object. On Queue failure, call `failUpload` and delete the object, then throw `ClaimedUploadError("queue_unavailable")`. Do not include caught error messages or response bodies in the error.

Refactor both file and URL routes to call the helper after their current validation/fetch/claim phases. Preserve all existing status codes and JSON bodies.

- [ ] **Step 4: Run focused GREEN**

Run: `npm.cmd test -- test/knowledge/claimed-upload.test.ts test/knowledge/file-upload.test.ts test/knowledge/url-ingest.test.ts test/knowledge/admin-routes.test.ts`

Expected: all existing upload contracts and new helper tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/knowledge/claimed-upload.ts src/knowledge/admin-routes.ts test/knowledge/claimed-upload.test.ts test/knowledge/file-upload.test.ts test/knowledge/url-ingest.test.ts
git commit -m "refactor: share claimed knowledge upload flow"
```

### Task 5: Add authenticated draft review endpoints

**Files:**
- Create: `src/knowledge/draft-routes.ts`
- Create: `test/knowledge/draft-routes.test.ts`
- Modify: `src/knowledge/admin-auth.ts`
- Modify: `src/knowledge/admin-routes.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Task 1 repository, Task 4 coordinator, existing admin bearer verification, R2, and ingestion Queue.
- Produces: the four approved `/admin/knowledge/drafts` endpoints.

- [ ] **Step 1: Write failing route tests**

Test every endpoint without, with invalid, and with valid bearer auth. Assert bounded list output, full detail, 404, approve success, repeated approval returning the same document ID, rejection idempotency, cross-transition 409, and sanitized 500/503 errors. For approval assert generated Markdown uses:

```ts
expect(objectStore.putOriginal).toHaveBeenCalledWith(
  expect.stringMatching(/\.md$/),
  expect.any(Blob),
  { originalName: expect.stringMatching(/\.md$/), mimeType: "text/markdown; charset=utf-8" },
);
```

On Queue failure assert the draft remains pending and a retry uses the same stable document/job IDs.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/knowledge/draft-routes.test.ts`

Expected: FAIL with 404 because the draft routes are not registered.

- [ ] **Step 3: Share the admin guard and implement routes**

Export a `requireKnowledgeAdmin` middleware factory from `admin-auth.ts` so document and draft routes use the same constant-time verification. Derive approval idempotency keys exactly as `knowledge-draft:${draft.id}` and stable document/job UUIDs with the existing SHA-256 UUID algorithm. Approval flow:

1. Read pending draft.
2. Claim a generated Markdown upload with source type `file`, display name `${safeTopic}.md`, extension `.md`, and content hash of the card.
3. Call `finalizeClaimedUpload`.
4. Atomically mark the draft approved with the stable document ID only after the Queue send succeeds.

If marking approved loses a race, return the persisted state; never enqueue a second job. Reject updates only pending rows and computes the 30-day expiry in the repository.

- [ ] **Step 4: Run GREEN**

Run: `npm.cmd test -- test/knowledge/draft-routes.test.ts test/knowledge/admin-routes.test.ts test/knowledge/claimed-upload.test.ts`

Expected: PASS with no secret or card content in console observations.

- [ ] **Step 5: Commit**

```powershell
git add src/knowledge/draft-routes.ts src/knowledge/admin-auth.ts src/knowledge/admin-routes.ts src/index.ts test/knowledge/draft-routes.test.ts test/knowledge/admin-routes.test.ts
git commit -m "feat: add knowledge draft review API"
```

### Task 6: Add expiry, E2E proof, operations, and complete verification

**Files:**
- Modify: `src/index.ts`
- Modify: `test/worker-dependencies.test.ts`
- Modify: `test/e2e/knowledge-search.test.ts`
- Modify: `test/logger.test.ts`
- Modify: `docs/setup/knowledge-search.md`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: scheduled draft expiry, operator workflow, and deploy-ready evidence.

- [ ] **Step 1: Write failing scheduled cleanup and E2E tests**

Extend scheduled injection so the same timestamp is passed to `KnowledgeDraftRepository.purgeExpired`. Assert pending drafts become rejected after 90 days, rejected drafts are deleted 30 days later, and approved provenance remains until its knowledge document is deleted. Add an E2E scenario that:

1. has empty knowledge retrieval;
2. obtains one Tavily HTTPS result;
3. returns a validated grounded answer;
4. verifies a pending draft exists;
5. approves it through the authenticated API;
6. drains the existing ingestion Queue and verifies the document is `ready`;
7. asks the same question and asserts knowledge evidence answers without another Tavily call.

Add logger type/runtime assertions that draft telemetry cannot contain `question`, `answer`, `markdown`, `url`, `snippet`, `authorization`, `token`, or provider payload fields.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/worker-dependencies.test.ts test/e2e/knowledge-search.test.ts test/logger.test.ts`

Expected: FAIL because cleanup and full review-to-retrieval flow are not wired.

- [ ] **Step 3: Wire cleanup and document operations**

Call `draftsFor(env).purgeExpired(timestamp())` in the scheduled handler alongside question cleanup. Treat a draft-cleanup failure like other scheduled cleanup failures: emit a sanitized failure event and fail the scheduled run after attempting all cleanup components.

Document commands that keep the token out of command history by reading it from `$env:ADMIN_API_TOKEN`. Include list, detail, approve, reject, D1 status checks, Queue inspection, and the same-question knowledge-first smoke. State explicitly that approval is mandatory and source credibility/copyright must be reviewed.

- [ ] **Step 4: Run focused and complete verification**

Run, in order:

```powershell
npm.cmd test -- test/knowledge/drafts.test.ts test/knowledge/draft-builder.test.ts test/knowledge/claimed-upload.test.ts test/knowledge/draft-routes.test.ts test/process-message.test.ts test/e2e/knowledge-search.test.ts test/logger.test.ts
npm.cmd run test:e2e:knowledge
npm.cmd run test:quality:knowledge
npm.cmd test
npm.cmd run typecheck
npx.cmd wrangler deploy --dry-run
```

Expected: every command exits 0, Vitest reports zero failures, TypeScript reports no errors, Wrangler confirms the existing D1/R2/Queue/Vectorize/AI bindings, and dry-run uploads no production version.

- [ ] **Step 5: Apply migration, deploy, and run production smoke**

```powershell
npx.cmd wrangler d1 migrations apply line-bot-diagnostics --remote
npx.cmd wrangler deploy
curl.exe --fail --silent --show-error https://line-running-community-bot.yamolineaichotbot.workers.dev/health
```

Send one web-fallback running question, use the authenticated draft API to approve the resulting pending draft, wait for the existing ingestion Queue, then ask the same question again. Query only operational fields:

```powershell
npx.cmd wrangler d1 execute line-bot-diagnostics --remote --command "SELECT status,document_id,created_at,updated_at FROM knowledge_drafts ORDER BY created_at DESC LIMIT 1; SELECT status,active_version,created_at,updated_at FROM knowledge_documents ORDER BY created_at DESC LIMIT 1"
```

Expected: first query shows `approved` with a non-null document ID; second shows `ready` with a non-null active version; the second LINE question answers without Tavily according to sanitized telemetry.

- [ ] **Step 6: Commit operations documentation**

```powershell
git add src/index.ts test/worker-dependencies.test.ts test/e2e/knowledge-search.test.ts test/logger.test.ts docs/setup/knowledge-search.md
git commit -m "docs: operate reviewed web knowledge drafts"
```
