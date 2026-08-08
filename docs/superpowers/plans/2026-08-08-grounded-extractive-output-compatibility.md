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

