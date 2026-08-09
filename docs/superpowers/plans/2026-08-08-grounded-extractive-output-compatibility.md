# Grounded Extractive Output Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Workers AI produce strictly verifiable extractive grounded JSON without weakening evidence safety.

**Architecture:** Normalize only a single whole-output JSON code fence before the existing strict parser, strengthen the generation contract to require verbatim evidence sentences, and expose validation failure categories as content-free metadata. Keep all existing validation gates and reviewed-draft publication boundaries.

**Tech Stack:** TypeScript, Cloudflare Workers AI, Vitest, structured telemetry, Wrangler.

## Global Constraints

- Do not weaken strict entailment, citation location, HTTPS, evidence-ID, or conflict validation.
- Never log or store question, answer, claim text, evidence text, URL, snippet, provider payload, Authorization header, token, LINE identifiers, or secrets.
- Preserve weather, administration, greeting, LINE delivery, knowledge-first routing, two-attempt generation, provider fallback, and mandatory human approval.
- Add no dependency, binding, Queue, Workflow, migration, or required Secret.

---

### Task 1: Accept safe fenced JSON and require extractive claims

**Files:**
- Modify: `src/answers/grounded.ts`
- Modify: `test/answers/grounded.test.ts`

**Interfaces:**
- Consumes: `GroundedGenerator.generate(messages)` and existing strict validation.
- Produces: the unchanged `GroundedAnswerService.answer(request): Promise<GroundedAnswer>` API.

- [ ] **Step 1: Write RED tests**

Add tests proving a whole-output ````json` fence containing valid JSON is accepted, prose outside the fence is rejected, and the system prompt requires verbatim evidence sentences plus an exact space-joined answer.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/answers/grounded.test.ts`
Expected: fenced valid JSON and prompt contract tests fail against the current parser/prompt.

- [ ] **Step 3: Implement the minimum parser and prompt changes**

Add a private normalizer that strips exactly one anchored `json` fence and passes its body to the existing `JSON.parse`; reject any prefix/suffix prose. Add explicit prompt sentences: each claim must be one complete verbatim sentence from a cited evidence `text`, no translation/paraphrase, and `answer` must be the claims joined in order with one space.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm.cmd test -- test/answers/grounded.test.ts`
Expected: all grounded tests pass.

Commit: `fix: align grounded output with strict evidence validation`

### Task 2: Add content-free validation classification and deploy proof

**Files:**
- Modify: `src/answers/grounded.ts`
- Modify: `src/index.ts`
- Modify: `src/telemetry/logger.ts`
- Modify: `test/answers/grounded.test.ts`
- Modify: `test/logger.test.ts`

**Interfaces:**
- Consumes: validation stages inside `GroundedAnswerService`.
- Produces: optional observer events containing only `{ attempt, outcome, reason, model? }` with a closed reason union.

- [ ] **Step 1: Write RED tests**

Test each closed failure reason and assert JSON serialization contains none of the forbidden content keys or fixture values. Test console projection drops injected `question`, `answer`, `claim`, `evidence`, `url`, `snippet`, `providerPayload`, `authorization`, and `token` fields.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/answers/grounded.test.ts test/logger.test.ts`
Expected: observer API/classification tests fail because no validation events exist.

- [ ] **Step 3: Implement metadata-only events**

Refactor validation to return a closed reason or success without returning content. Emit one event per failed generation attempt and a success event only after all validation gates pass. Wire the observer to the existing structured logger with no correlation or content fields.

- [ ] **Step 4: Verify locally**

Run in order:

```powershell
npm.cmd test -- test/answers/grounded.test.ts test/process-message.test.ts test/logger.test.ts test/e2e/knowledge-search.test.ts
npm.cmd test
npm.cmd run typecheck
npx.cmd wrangler deploy --dry-run
```

Expected: zero failures; dry-run lists existing bindings and deploys nothing.

- [ ] **Step 5: Review, deploy, and smoke**

After independent review, run `npx.cmd wrangler deploy`. Send the same ordinary running question. Verify the LINE answer has HTTPS Sources and D1 has one `pending` draft. Approve only after human source/content review, drain the existing Queue, then verify the same question uses ready knowledge without another web search.

Commit: `chore: observe grounded validation outcomes safely`

### Task 3: Use a JSON Mode-supported Workers AI fallback

**Files:**
- Modify: `src/answers/grounded-generators.ts`
- Modify: `src/index.ts`
- Modify: `test/answers/grounded-generators.test.ts`
- Modify: `test/worker-dependencies.test.ts`

**Interfaces:**
- Consumes: `WorkersAiGroundedGenerator.generate(messages)`.
- Produces: the unchanged `GroundedGeneration` API using model `@cf/meta/llama-3.1-8b-instruct-fast`.

- [ ] **Step 1: Write RED tests**

Assert the Workers AI binding receives `response_format: { type: "json_schema", json_schema: ... }`; the schema sets `additionalProperties: false`, requires `answer` and `claims`, requires each claim's `text` and non-empty unique `evidenceIds`, and the production fallback telemetry names the new model. Assert a structured object returned in `payload.response` is safely serialized to JSON text for the unchanged downstream parser, while string responses remain supported.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts test/worker-dependencies.test.ts`
Expected: model/schema/object-response assertions fail against the 3B text-only request.

- [ ] **Step 3: Implement minimal JSON Mode fallback**

Change only the Workers AI grounded fallback constant/request. Pass the closed JSON Schema to `env.AI.run`. Accept only a string response or a plain object response that can be safely `JSON.stringify`-serialized; reject empty, array, or unrepresentable output as `malformed`. Keep OpenRouter priority and all downstream parsing/validation unchanged.

- [ ] **Step 4: Verify and commit**

Run focused tests, full tests, typecheck, and Wrangler dry-run. Commit `fix: use structured Workers AI grounded fallback`.

### Task 4: Safely classify Workers AI binding failures

**Files:**
- Modify: `src/answers/grounded-generators.ts`
- Modify: `test/answers/grounded-generators.test.ts`

**Interfaces:**
- Consumes: an unknown exception rejected by `Ai.run`.
- Produces: the existing `GroundedProviderError` with optional safe metadata `{ errorName?, code?, status? }`, projected into `attempt.failed` without raw exception content.

- [ ] **Step 1: Write RED tests**

Add a Workers AI binding rejection containing a safe error name, numeric code, HTTP status, and forbidden message/stack/content fields. Assert `attempt.failed` contains only the normalized name, finite numeric code, and valid status, and its serialized form excludes all forbidden fixture values. Add malformed metadata cases proving strings, objects, non-finite numbers, and invalid status values are omitted.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts`
Expected: the safe diagnostic fields are absent because unknown Workers AI exceptions still become generic `network` failures.

- [ ] **Step 3: Implement the minimum safe projection**

Catch only the Workers AI binding rejection. Normalize `error.name` to a closed allowlist of platform error class names, accept only finite numeric `code`, and accept only integer HTTP `status` from 400 through 599. Throw a `GroundedProviderError` carrying those projected fields. Extend `attempt.failed` with these optional scalar fields; never retain or serialize the original exception.

- [ ] **Step 4: Verify, commit, and deploy**

Run focused tests, full tests, typecheck, and `npx.cmd wrangler deploy --dry-run`. Commit `chore: classify Workers AI binding failures safely`, deploy with `npx.cmd wrangler deploy`, then collect one production diagnostic attempt.

### Task 5: Categorize opaque Workers AI error messages without logging them

**Files:**
- Modify: `src/answers/grounded-generators.ts`
- Modify: `test/answers/grounded-generators.test.ts`

**Interfaces:**
- Consumes: an optional transient primitive string rejection or string from a rejected Workers AI exception's `message` property.
- Produces: `diagnosticCategory: "json_mode_unmet" | "capacity" | "account_limited" | "invalid_model" | "bad_input" | "unknown"` on the existing sanitized failure event.

- [ ] **Step 1: Write RED tests**

Use table-driven tests for the documented phrases `JSON Mode couldn't be met`, `No more data centers to forward the request`, `used up your daily free allocation`, `No such model`, `model name is invalid`, `BadInput`, and `Request is missing`. Assert each maps to its closed category and serialized telemetry excludes the complete original message. Test arbitrary text and a throwing `message` getter map to `unknown` without leaking text.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts`
Expected: category assertions fail because opaque binding errors currently expose only generic `network`.

- [ ] **Step 3: Implement minimal closed classification**

Accept a primitive string rejection directly; otherwise read `message` through the existing fail-closed property accessor. Compare a lowercase in-memory value only against the documented phrases and immediately reduce it to the closed category. Carry only that category through `GroundedProviderError` and `attempt.failed`. Never store, spread, serialize, or log the message.

- [ ] **Step 4: Verify, review, commit, and deploy**

Run focused tests, full tests, typecheck, and Wrangler dry-run. Obtain independent leakage review, commit `chore: classify opaque Workers AI failures`, deploy, and collect one new production diagnostic.

### Task 6: Add an authenticated controlled Workers AI probe

**Files:**
- Create: `src/diagnostics/workers-ai-probes.ts`
- Create: `src/diagnostics/provider-routes.ts`
- Create: `test/diagnostics/workers-ai-probes.test.ts`
- Create: `test/diagnostics/provider-routes.test.ts`
- Modify: `src/answers/grounded-generators.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Ai.run`, `ADMIN_API_TOKEN`, the production Workers AI model and grounded response schema.
- Produces: `runWorkersAiProbes(ai): Promise<{ probes: ProbeResult[] }>` and authenticated `POST /admin/diagnostics/workers-ai-probes`.

- [ ] **Step 1: Write RED unit and route tests**

Assert three sequential calls use fixed messages only: baseline without `response_format`, minimal JSON Schema, and the production grounded schema. Assert resolved calls return only `{ name, outcome: "success" }`; rejected calls return only `{ name, outcome: "failed", diagnosticCategory }`, with no raw prompt, output, message, error, stack, authorization, or token. Assert missing/wrong bearer tokens return the existing stable 401 without invoking AI, request bodies are ignored, and authenticated calls return the safe probe result.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/diagnostics/workers-ai-probes.test.ts test/diagnostics/provider-routes.test.ts`
Expected: tests fail because the probe runner and route do not exist.

- [ ] **Step 3: Implement the minimal probe boundary**

Export the existing production grounded response format and closed Workers AI failure classifier. Implement three sequential fixed-input calls, discard every successful output immediately, and reduce every rejection immediately to the closed category. Register the POST route with `requireKnowledgeAdmin`; accept no request-derived probe input and return a stable internal error if the probe runner itself unexpectedly fails.

- [ ] **Step 4: Verify, review, commit, deploy, and invoke once**

Run focused tests, full tests, typecheck, and Wrangler dry-run. Obtain independent security review, commit `feat: add controlled Workers AI diagnostics`, deploy, invoke the endpoint once with the existing bearer token, record only the three safe results, then remove or disable the endpoint after root-cause analysis.

### Task 7: Split the grounded schema into progressive probes

**Files:**
- Modify: `src/diagnostics/workers-ai-probes.ts`
- Modify: `test/diagnostics/workers-ai-probes.test.ts`
- Modify: `test/diagnostics/provider-routes.test.ts`

**Interfaces:**
- Consumes: the existing authenticated probe endpoint and fixed synthetic prompt.
- Produces: six ordered safe probe results named `baseline`, `simple_json`, `nested_shape`, `closed_required`, `nonempty`, and `grounded_schema`.

- [ ] **Step 1: Write RED tests**

Assert six sequential calls and cumulative schemas: nested types only; required fields plus `additionalProperties: false`; non-empty constraints; then production `uniqueItems`. Assert every successful output is discarded, every failure is reduced to the closed category, and route responses still contain only the safe report.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/diagnostics/workers-ai-probes.test.ts test/diagnostics/provider-routes.test.ts`
Expected: six-probe order/schema assertions fail because only three probes exist.

- [ ] **Step 3: Implement cumulative fixed schemas**

Define immutable cumulative schema constants using the same fixed synthetic messages for all four grounded variants. Execute them sequentially and preserve the existing safe result reduction. Do not read request data or alter the production grounded generator schema.

- [ ] **Step 4: Verify, review, commit, deploy, and invoke once**

Run focused tests, full tests, typecheck, and Wrangler dry-run. Obtain independent review, commit `chore: isolate grounded schema compatibility`, deploy, invoke once, and use the first failed progressive probe as the root-cause boundary.
