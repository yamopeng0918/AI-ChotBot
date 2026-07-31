# Knowledge Search Task 11 Design

Date: 2026-07-22

## Goal

Add a final validation layer for the knowledge-search branch that proves the full offline workflow, exposes a deterministic quality gate, and documents the operational path to provision, smoke test, and recover the system.

This task does not add new product behavior. It packages the existing knowledge-search implementation into three operable deliverables:

1. an end-to-end integration test for the full knowledge path,
2. an executable synthetic quality evaluator,
3. a runbook plus script entry points for staging smoke and dry-run verification.

## Scope

In scope:

- Miniflare-based E2E coverage for upload, URL ingest, queue dispatch, conversion, embedding, Vectorize, retrieval, grounded answer generation, reindex, and delete.
- Deterministic quality evaluation over synthetic fixtures with pass/fail thresholds.
- Local executable commands for quality evaluation and knowledge smoke validation.
- A knowledge-search runbook covering provisioning, smoke tests, DLQ handling, rollback, and monitoring.
- Minimal `package.json` script additions needed to run the above consistently.

Out of scope:

- New production routes or API surfaces.
- New retrieval or answer logic.
- Real external service calls in tests.
- UI changes.
- Broader refactors unrelated to the validation and operations surface.

## Approach

Use the existing worker architecture and keep the new work thin:

- E2E test will exercise the real worker entrypoint with Miniflare D1 and behaviorally faithful fakes for R2, AI, Vectorize, Tavily, and OpenRouter.
- Quality evaluation will stay in Vitest so it runs in the same CI path as the rest of the repo, but it will read a dedicated fixture file and compute deterministic metrics.
- Runbook documentation will live in `docs/setup/knowledge-search.md`, with command examples aligned to the actual scripts and Wrangler commands used by the repository.

This keeps the validation surface close to the runtime code without creating a second parallel implementation.

## Proposed Files

Create:

- `test/e2e/knowledge-search.test.ts`
- `test/quality/knowledge-evaluation.test.ts`
- `test/fixtures/knowledge/evaluation.json`
- `docs/setup/knowledge-search.md`

Modify:

- `package.json`
- `README.md`

## End-to-End Test Design

The E2E test will model the complete lifecycle with deterministic fakes:

- signed LINE webhook ingestion,
- queue handoff into question processing,
- knowledge-first answer generation,
- conditional web search when retrieval confidence is insufficient,
- fallback disclosure when web search fails,
- citation rendering with a LINE-safe plain-text reply,
- duplicate webhook idempotency,
- reindex preserving the currently active version until publish,
- delete marking a tombstone before async cleanup, and
- stale delete protection when a replacement version already exists.

The test should assert behavior, not internal implementation details. It may observe D1 state, queue messages, and outbound fetch calls, but it should not duplicate the business logic under test.

Recommended fixture strategy:

- one realistic file-ingest flow,
- one realistic URL-ingest flow,
- one duplicate delivery case,
- one reindex case,
- one delete case,
- one web-failure case that still succeeds from KB evidence.

The test should continue to use `Miniflare` and the existing worker entrypoint rather than creating separate test-only routes.

## Quality Evaluator Design

The evaluator will be a deterministic Vitest test that reads a JSON fixture and scores a synthetic corpus.

Fixture shape:

- `question`
- `expectedSource`
- `expectedChunk`
- `supportedClaims`
- `expectedAbstention`

Evaluation rules:

- generate or simulate a grounded answer path using the same citation-support rules as production-facing validation,
- score citation support on whether the top cited source/chunk matches the expected source/chunk,
- score retrieval quality using a Top-5 hit metric,
- require at least 50 synthetic cases,
- fail if citation support falls below `0.90`,
- fail if Top-5 hit rate falls below `0.85`,
- fail if abstention behavior is inconsistent with the fixture expectation.

The fixture content should be synthetic and deterministic. It should not depend on live external data or manually curated documents in the repository.

## Script and Entry Point Design

Add small scripts in `package.json` so the same checks can be run locally and in CI without remembering long command lines.

Recommended scripts:

- `test:e2e:knowledge` for `vitest run test/e2e/knowledge-search.test.ts`
- `test:quality:knowledge` for `vitest run test/quality/knowledge-evaluation.test.ts`

Keep the existing `test`, `typecheck`, `dev`, and `deploy` scripts unchanged.

For operational validation, rely on the existing `npm run deploy -- --dry-run` command rather than introducing a separate deploy wrapper.

## Runbook Design

Create `docs/setup/knowledge-search.md` as the operator-facing guide for:

- Cloudflare resource provisioning,
- D1 migration application,
- R2 / Vectorize / AI / Queue bindings,
- secret rotation,
- staging upload and URL smoke checks,
- reindex and delete smoke checks,
- DLQ inspection and replay,
- rollback steps,
- monitoring notes for Workers AI, Vectorize, R2, Tavily credits, and queue backlog.

The runbook should document exact commands, not just conceptual steps, and it should match the scripts and worker behavior that the repository actually ships.

## Verification Plan

Task 11 will be considered complete only when all of the following pass:

- `npm.cmd test`
- `npm.cmd run typecheck`
- `npm.cmd run deploy -- --dry-run`

The E2E and evaluator tests should be part of `npm.cmd test`, so the final branch verification naturally includes them.

## Acceptance Criteria

- The E2E test proves the full knowledge-search happy path and the reindex/delete contract.
- The quality evaluator is deterministic, executable, and enforces the stated thresholds.
- The runbook is actionable and matches the current worker and Wrangler workflow.
- The branch remains green under full test, typecheck, and Wrangler dry-run verification.
