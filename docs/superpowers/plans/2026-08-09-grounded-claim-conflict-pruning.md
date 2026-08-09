# Grounded Claim Conflict Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve individually validated, mutually compatible grounded claims while deterministically removing cross-claim contradictions.

**Architecture:** Keep parsing and every per-claim fail-closed validation gate unchanged. After all claims pass those gates, compute conflicting pairs, mark lower-authority claims for removal, mark both sides when authority is equal, then render only the unmarked claims; an empty result remains a `conflict` failure.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers AI, Vitest, Wrangler.

## Global Constraints

- Knowledge evidence authority is `2`; web evidence authority is `1`.
- A claim's authority is the maximum authority of its cited evidence.
- Resolve every conflicting pair from the original validated set before filtering, so input order cannot change the retained set.
- Do not silently remove a claim that fails citation, duplicate-ID, location, cited-evidence conflict, or strict entailment validation; the whole generation attempt must fail with the existing reason.
- Equal-authority conflicting claims are both removed.
- When no claims remain, return `conflict` and preserve the existing correction attempt and insufficient-evidence fallback.
- Rendered text, citations, `usedEvidenceIds`, `validatedClaims`, and draft material may contain only retained claims.
- Telemetry may add only `discardedClaimCount`; it must not expose content or identity fields.
- Do not change provider order, attempt count, schema, human approval, R2, Queue, or Vectorize behavior.

---

## File structure

- Modify `src/answers/grounded.ts`: validate individual claims, prune cross-claim conflicts, return the retained parsed value, and emit the safe discard count.
- Modify `src/telemetry/logger.ts`: project `discardedClaimCount` only on grounded validation success events.
- Modify `test/answers/grounded.test.ts`: define conflict-pruning behavior, order invariance, empty-result fallback, unchanged individual failure gates, and content-free observer output.
- Modify `test/logger.test.ts`: prove runtime telemetry projection includes the numeric count and excludes forbidden content.
- Modify `test/process-message.test.ts`: prove downstream draft input contains only the retained claim/source set when a grounded result has been pruned.

### Task 1: Specify conflict pruning with failing grounded-answer tests

**Files:**
- Modify: `test/answers/grounded.test.ts`

**Interfaces:**
- Consumes: `GroundedAnswerService.answer(request): Promise<GroundedAnswer>`.
- Produces: executable requirements for pruning and `GroundedValidationEvent.discardedClaimCount`.

- [ ] **Step 1: Replace the lower-authority whole-answer rejection assertion with a retention assertion**

Use knowledge text `Registration is closed.` and web text `Registration is open.` with an injected entailment checker returning true. Assert the returned answer contains only the knowledge sentence/source, `usedEvidenceIds` equals `["official"]`, and `validatedClaims` equals only the official claim.

- [ ] **Step 2: Add equal-authority and order-invariance tests**

Create three knowledge claims: the conflicting pair `Registration is closed.` / `Registration is open.` and the unrelated `Hydrate every 20 minutes.`. Assert both conflict orders retain only hydration. Create knowledge-vs-web variants in both orders and assert both retain the same knowledge claim.

- [ ] **Step 3: Keep the all-pruned case fail-closed**

Return only the equal-authority conflicting pair on both generation attempts. Assert two generator calls, two `conflict` failure events, and `INSUFFICIENT_EVIDENCE_TEXT`.

- [ ] **Step 4: Assert safe success telemetry**

For knowledge-vs-web conflict, assert the event is exactly:

```ts
{
  attempt: 1,
  outcome: "success",
  reason: "validated",
  model: "grounded-model",
  discardedClaimCount: 1,
}
```

Serialize the event and assert it contains none of the question, provider output, claims, evidence text, URLs, tokens, or identity-field names.

- [ ] **Step 5: Run RED**

Run:

```powershell
npm.cmd test -- test/answers/grounded.test.ts
```

Expected: the retention, order-invariance, unrelated-survivor, and telemetry-count assertions fail because current `crossClaimConflict` rejects the entire parsed result.

### Task 2: Implement deterministic pruning in the grounded service

**Files:**
- Modify: `src/answers/grounded.ts`
- Test: `test/answers/grounded.test.ts`

**Interfaces:**
- Produces: `ValidationResult = { parsed: Parsed; discardedClaimCount: number } | GroundedValidationFailureReason`.
- Produces: success `GroundedValidationEvent` with optional `discardedClaimCount?: number`.

- [ ] **Step 1: Change validation to return retained claims**

After the existing per-claim loop succeeds, call a new pure helper:

```ts
function pruneCrossClaimConflicts(
  claims: GroundedClaim[],
  evidence: KnowledgeEvidence[][],
): GroundedClaim[] {
  const discarded = new Set<number>();
  for (let left = 0; left < claims.length; left++) {
    for (let right = left + 1; right < claims.length; right++) {
      if (!claimsConflict(claims[left]!, claims[right]!, evidence[left]!, evidence[right]!)) continue;
      const leftRank = authorityRank(evidence[left]!);
      const rightRank = authorityRank(evidence[right]!);
      if (leftRank === rightRank) { discarded.add(left); discarded.add(right); }
      else discarded.add(leftRank < rightRank ? left : right);
    }
  }
  return claims.filter((_claim, index) => !discarded.has(index));
}
```

Extract the current pair predicate from `crossClaimConflict` into `claimsConflict(...)`. Implement `authorityRank(items)` as maximum `2` for `sourceType === "knowledge"`, otherwise `1`. Do not skip pair comparisons merely because an item was already marked.

- [ ] **Step 2: Preserve failures and render only retained claims**

Return the original citation/location/cited-conflict/entailment reasons immediately. If pruning returns an empty array, return `"conflict"`. Otherwise return a new `Parsed` containing retained claims and the discarded count. Pass this retained `Parsed` to `render`.

- [ ] **Step 3: Emit the discard count only on successful validation**

Extend the success event type with `discardedClaimCount?: number`. Include the property only when the count is greater than zero. Do not add it to failure events.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm.cmd test -- test/answers/grounded.test.ts
```

Expected: all grounded-answer tests pass, including unchanged failure-matrix cases.

- [ ] **Step 5: Commit the grounded behavior**

```powershell
git add src/answers/grounded.ts test/answers/grounded.test.ts
git commit -m "fix: prune conflicting grounded claims"
```

### Task 3: Project pruning metadata safely and protect downstream drafts

**Files:**
- Modify: `src/telemetry/logger.ts`
- Modify: `test/logger.test.ts`
- Modify: `test/process-message.test.ts`

**Interfaces:**
- Consumes: `GroundedValidationEvent.discardedClaimCount?: number`.
- Produces: metadata-only telemetry and draft calls based only on retained `GroundedAnswer.validatedClaims` / `usedEvidenceIds`.

- [ ] **Step 1: Write RED logger projection test**

Emit a successful grounded validation event with `discardedClaimCount: 2`. Assert the projected record includes exactly the existing success keys plus `discardedClaimCount: 2`. Keep the forbidden-key serialization assertions.

- [ ] **Step 2: Write downstream retained-draft test**

In `test/process-message.test.ts`, configure the grounded service result to contain only a retained web claim and retained web evidence ID while search results contain an additional discarded source. Assert `createOrRefresh` receives markdown/sources derived only from the retained claim and retained source, and does not contain the discarded source title, URL, or text.

- [ ] **Step 3: Run RED**

Run:

```powershell
npm.cmd test -- test/logger.test.ts test/process-message.test.ts
```

Expected: logger projection omits `discardedClaimCount`; the downstream draft assertion should pass if the existing retained-ID boundary is already correct and serves as a regression lock.

- [ ] **Step 4: Implement safe telemetry projection**

In the grounded success branch of `projectEvent`, add:

```ts
...(event.discardedClaimCount !== undefined
  ? { discardedClaimCount: event.discardedClaimCount }
  : {}),
```

Do not add the field to general telemetry or grounded failure projection.

- [ ] **Step 5: Run GREEN and typecheck**

Run:

```powershell
npm.cmd test -- test/logger.test.ts test/process-message.test.ts test/answers/grounded.test.ts
npm.cmd run typecheck
```

Expected: all selected tests and TypeScript checks pass.

- [ ] **Step 6: Commit telemetry and downstream regression coverage**

```powershell
git add src/telemetry/logger.ts test/logger.test.ts test/process-message.test.ts
git commit -m "test: protect pruned claim metadata and drafts"
```

### Task 4: Verify, review, deploy, and smoke-test production

**Files:**
- Verify all modified files.
- Do not create a diagnostic HTTP endpoint.

**Interfaces:**
- Consumes: committed Tasks 1-3.
- Produces: deployed Worker with verified metadata-only production behavior.

- [ ] **Step 1: Run full local verification**

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check
npx.cmd wrangler deploy --dry-run
```

Expected: all tests pass, bindings are current, no whitespace errors, and dry-run lists Queue, D1, Vectorize, R2, and AI bindings.

- [ ] **Step 2: Obtain independent security and regression review**

Review the branch diff against `docs/superpowers/specs/2026-08-09-grounded-claim-conflict-pruning-design.md`. Block deployment for any route that renders an unvalidated/discarded claim, selects equal-authority conflict by order, weakens an individual validation gate, or logs content.

- [ ] **Step 3: Deploy and health-check**

```powershell
npx.cmd wrangler deploy
Invoke-WebRequest -Uri 'https://line-running-community-bot.yamolineaichotbot.workers.dev/health' -UseBasicParsing
```

Expected: deploy returns a new Version ID and health returns HTTP 200 with `{"status":"ok"}`.

- [ ] **Step 4: Run one controlled production smoke**

Start one `wrangler tail` session, ask the user to send an ordinary running question, and inspect metadata only. Success criteria: Workers AI is attempted first; at least one validated claim produces HTTPS citations; any pruning reports only `discardedClaimCount`; a web-backed answer creates one pending draft; OpenRouter is unused unless Workers AI itself fails.

- [ ] **Step 5: Always stop tail and report exact outcome**

Stop the exact `wrangler tail line-running-community-bot` process chain. Report provider, validation outcomes, discard count, draft status, deployed Version ID, and whether the bot safely fell back. Do not report question, answer, claim, source, URL, or provider payload content.
