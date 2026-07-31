# Knowledge Search Task 11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline end-to-end knowledge-search verification path, a deterministic quality evaluator, and an operator runbook with scripts for smoke, dry-run, and recovery workflows.

**Architecture:** Keep the validation surface thin and close to the existing worker. The E2E test uses Miniflare plus deterministic fakes to prove the full worker path without live external services. The quality evaluator stays in Vitest and scores a synthetic fixture corpus with stable thresholds. The runbook documents the real provisioning and smoke commands already supported by the repository.

**Tech Stack:** TypeScript, Vitest, Miniflare, Cloudflare Workers runtime, Wrangler, existing worker and repository abstractions.

## Global Constraints

- Miniflare-based E2E coverage for upload, URL ingest, queue dispatch, conversion, embedding, Vectorize, retrieval, grounded answer generation, reindex, and delete.
- Deterministic quality evaluation over synthetic fixtures with pass/fail thresholds.
- Local executable commands for quality evaluation and knowledge smoke validation.
- A knowledge-search runbook covering provisioning, smoke tests, DLQ handling, rollback, and monitoring.
- Minimal `package.json` script additions needed to run the above consistently.
- No new production routes or API surfaces.
- No new retrieval or answer logic.
- No real external service calls in tests.
- Final branch verification must pass `npm.cmd test`, `npm.cmd run typecheck`, and `npm.cmd run deploy -- --dry-run`.

---

### Task 1: Build the end-to-end knowledge-search test harness

**Files:**
- Create: `test/e2e/knowledge-search.test.ts`
- Modify: `src/index.ts`
- Modify: `src/knowledge/admin-routes.ts`

**Interfaces:**
- Consumes: `createWorker`, `QuestionJob`, existing LINE webhook signature helpers, Miniflare D1 setup, and the current knowledge/admin route registration.
- Produces: a reusable test harness that can drive signed webhook delivery, queue flushing, and direct admin lifecycle requests through the real worker entrypoint.

- [ ] **Step 1: Write the failing integration coverage**

Create `test/e2e/knowledge-search.test.ts` with one test per required path:

```ts
it("covers upload, URL ingest, knowledge-first answer, fallback web search, reindex, and delete", async () => {
  // Arrange worker + D1 + deterministic fakes.
  // Act: upload file, submit URL, deliver LINE webhook, drain queue, request reindex, request delete.
  // Assert: prepared rows exist before reply, citation-safe answer is sent, web fallback is conditional, duplicate delivery is idempotent,
  // reindex keeps the old version searchable until publish, delete tombstones before cleanup, and stale delete cannot remove replacement content.
});
```

The test must assert behavior through HTTP responses, queue messages, D1 rows, and outbound fetch calls. It must not call internal helper methods directly.

- [ ] **Step 2: Run the new test and confirm the initial failures**

Run: `npm.cmd test -- test/e2e/knowledge-search.test.ts`

Expected: FAIL because the test file is new or because the worker wiring is still incomplete for at least one asserted lifecycle path.

- [ ] **Step 3: Implement only the missing worker wiring required by the E2E**

Make the smallest possible production-safe changes in `src/index.ts` and `src/knowledge/admin-routes.ts` so the E2E can reach the real routes and queue paths without test-only HTTP endpoints. Keep using the existing worker entrypoint and dependency injection model.

- [ ] **Step 4: Re-run the E2E until it passes**

Run: `npm.cmd test -- test/e2e/knowledge-search.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the harness**

```powershell
git add test/e2e/knowledge-search.test.ts src/index.ts src/knowledge/admin-routes.ts
git commit -m "test: cover knowledge-search end-to-end"
```

### Task 2: Add the synthetic quality evaluator and fixture corpus

**Files:**
- Create: `test/quality/knowledge-evaluation.test.ts`
- Create: `test/fixtures/knowledge/evaluation.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: grounded-answer validation rules, retrieval routing summary, and deterministic fixture data.
- Produces: a test that computes citation-support and Top-5 retrieval metrics from at least 50 synthetic cases.

- [ ] **Step 1: Write the failing evaluator and fixture**

Create a deterministic fixture file with at least 50 cases:

```json
[
  {
    "question": "Where is the race start?",
    "expectedSource": "knowledge",
    "expectedChunk": "start-line",
    "supportedClaims": ["The race starts at Riverside Park."],
    "expectedAbstention": false
  }
]
```

Create `test/quality/knowledge-evaluation.test.ts` that loads the fixture and computes:

- citation support rate,
- Top-5 hit rate,
- abstention consistency.

Set the test to fail when citation support drops below `0.90` or Top-5 hit rate drops below `0.85`.

- [ ] **Step 2: Run the evaluator and confirm the missing implementation**

Run: `npm.cmd test -- test/quality/knowledge-evaluation.test.ts`

Expected: FAIL until the fixture file and evaluator logic are present.

- [ ] **Step 3: Implement the minimal scoring helpers**

If needed, add a small pure helper in the quality test file itself so the evaluator can reuse the same validation logic without duplicating it. Do not change production code unless the test cannot be expressed otherwise.

- [ ] **Step 4: Re-run the evaluator until it passes**

Run: `npm.cmd test -- test/quality/knowledge-evaluation.test.ts`

Expected: PASS with all thresholds satisfied.

- [ ] **Step 5: Commit the evaluator**

```powershell
git add test/quality/knowledge-evaluation.test.ts test/fixtures/knowledge/evaluation.json package.json
git commit -m "test: add knowledge quality evaluator"
```

### Task 3: Add operational scripts and the knowledge-search runbook

**Files:**
- Create: `docs/setup/knowledge-search.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the actual provision/smoke/rollback commands used by the worker and existing README setup style.
- Produces: documented commands for provisioning, staging smoke, reindex/delete smoke, DLQ replay, and monitoring.

- [ ] **Step 1: Write the runbook draft and script entries**

Update `package.json` with the following scripts:

```json
{
  "scripts": {
    "test:e2e:knowledge": "vitest run test/e2e/knowledge-search.test.ts",
    "test:quality:knowledge": "vitest run test/quality/knowledge-evaluation.test.ts"
  }
}
```

Create `docs/setup/knowledge-search.md` with exact commands for:

- resource creation,
- D1 migration application,
- secret setup,
- staging smoke,
- query smoke,
- reindex smoke,
- delete smoke,
- DLQ inspection and replay,
- rollback,
- monitoring.

Update `README.md` only as needed to link to the new runbook and mention the new scripts.

- [ ] **Step 2: Run the new scripts and dry-run gate**

Run:

```powershell
npm.cmd test:e2e:knowledge
npm.cmd test:quality:knowledge
npm.cmd run deploy -- --dry-run
```

Expected:

- the knowledge tests pass,
- the dry-run prints Wrangler configuration details,
- the dry-run exits without deploying.

- [ ] **Step 3: Commit the runbook and scripts**

```powershell
git add docs/setup/knowledge-search.md README.md package.json
git commit -m "docs: add knowledge search operations gate"
```

### Task 4: Final branch verification and progress ledger update

**Files:**
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: the commits from Tasks 1-3 and the current test/dry-run outputs.
- Produces: updated SDD progress and a verified branch ready for handoff.

- [ ] **Step 1: Re-run the full verification gate**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
git diff --check
```

Expected:

- all tests pass,
- typecheck exits 0,
- Wrangler dry-run exits 0,
- diff check is clean.

- [ ] **Step 2: Update the durable SDD progress ledger**

Mark Task 11 complete in `.superpowers/sdd/progress.md` with the commit hash from Task 3 and the final verification results.

- [ ] **Step 3: Final commit for the ledger**

```powershell
git add .superpowers/sdd/progress.md
git commit -m "docs: record knowledge search task 11 completion"
```
