# Grounded Sentence Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-authored grounded claims with model-selected server-owned evidence sentences, limited to three selections per answer.

**Architecture:** A new pure candidate builder splits evidence into bounded request-local sentences. `GroundedAnswerService` prompts providers with those candidates, parses only sentence IDs, resolves IDs back to original text and evidence, then applies the existing location, strict entailment, deterministic conflict-pruning, rendering, and draft boundaries.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers AI JSON Schema, Vitest, Wrangler.

## Global Constraints

- Candidate IDs are request-local `s0`, `s1`, ... and never provider-authored metadata.
- Preserve original sentence text; do not translate or paraphrase it.
- Limit candidates to the first 5 non-empty sentences per evidence and 30 total.
- Accept exactly 1 to 3 unique known `sentenceIds`; no extra JSON fields.
- Do not add `uniqueItems` to the Workers AI schema.
- Keep strict entailment as defense-in-depth.
- Keep deterministic conflict pruning: knowledge beats web; equal authority removes both; all pairs are computed before filtering.
- Keep two generation attempts and Workers AI-first provider-call fallback.
- Render and draft only retained server-mapped sentences/evidence.
- Telemetry may add only numeric `selectedSentenceCount`; do not expose content or identities.
- Do not alter weather, admin, greeting, Tavily, human review, R2, Queue, DLQ, or Vectorize behavior.

---

## File structure

- Create `src/answers/evidence-sentences.ts`: pure bounded sentence splitting and request-local mapping.
- Create `test/answers/evidence-sentences.test.ts`: exact text, ID, per-evidence, and total-limit tests.
- Modify `src/answers/grounded-generators.ts`: Workers AI `sentenceIds` schema.
- Modify `test/answers/grounded-generators.test.ts`: exact schema and structured-response fixtures.
- Modify `src/answers/grounded.ts`: prompt/parser/ID resolution/validation/rendering orchestration.
- Modify `test/answers/grounded.test.ts`: selection contract and all fail-closed matrices.
- Modify `src/telemetry/logger.ts` and `test/logger.test.ts`: safe numeric selection metadata.
- Modify `test/process-message.test.ts`, `test/worker-dependencies.test.ts`, and `test/e2e/knowledge-search.test.ts` only where fixtures assert the grounded provider contract or retained draft boundary.

### Task 1: Build bounded server-owned sentence candidates

**Files:**
- Create: `src/answers/evidence-sentences.ts`
- Create: `test/answers/evidence-sentences.test.ts`

**Interfaces:**
- Produces: `SentenceCandidate = { id: string; text: string; evidence: KnowledgeEvidence }`.
- Produces: `buildSentenceCandidates(evidence: KnowledgeEvidence[]): SentenceCandidate[]`.

- [ ] **Step 1: Write RED tests for splitting and stable IDs**

Assert `"First sentence. Second sentence！\nThird sentence?"` becomes exact visible texts with IDs `s0`, `s1`, `s2` and the original evidence object on every candidate. Assert empty fragments are omitted and input evidence is not mutated.

- [ ] **Step 2: Write RED bound tests**

Give one evidence six sentences and assert only five candidates. Give seven evidence items with five sentences each and assert exactly 30 candidates ending at `s29`.

- [ ] **Step 3: Run RED**

```powershell
npm.cmd test -- test/answers/evidence-sentences.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement the pure builder**

Use constants `MAX_SENTENCES_PER_EVIDENCE = 5` and `MAX_SENTENCE_CANDIDATES = 30`. Split with a Unicode-aware matcher that retains terminal `.`, `!`, `?`, `。`, `！`, `？`, `;`, or `；`; trim only leading/trailing whitespace. Stop before adding candidate 31.

```ts
export type SentenceCandidate = { id: string; text: string; evidence: KnowledgeEvidence };

export function buildSentenceCandidates(evidence: KnowledgeEvidence[]): SentenceCandidate[] {
  const result: SentenceCandidate[] = [];
  for (const item of evidence) {
    const sentences = splitSentences(item.text).slice(0, 5);
    for (const text of sentences) {
      if (result.length === 30) return result;
      result.push({ id: `s${result.length}`, text, evidence: item });
    }
  }
  return result;
}
```

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm.cmd test -- test/answers/evidence-sentences.test.ts
git add src/answers/evidence-sentences.ts test/answers/evidence-sentences.test.ts
git commit -m "feat: build grounded sentence candidates"
```

Expected: candidate tests pass.

### Task 2: Change the provider contract to sentence IDs only

**Files:**
- Modify: `src/answers/grounded-generators.ts`
- Modify: `test/answers/grounded-generators.test.ts`

**Interfaces:**
- Produces: `WORKERS_AI_GROUNDED_RESPONSE_FORMAT` for `{ sentenceIds: string[] }`.
- Leaves `GroundedGenerator.generate(messages)` unchanged.

- [ ] **Step 1: Write RED exact-schema assertions**

Require this schema and assert `uniqueItems` is absent:

```ts
{
  type: "json_schema",
  json_schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentenceIds"],
    properties: {
      sentenceIds: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", minLength: 1 },
      },
    },
  },
}
```

Update string/object response fixtures to `{"sentenceIds":["s0"]}` without changing provider error tests.

- [ ] **Step 2: Run RED**

```powershell
npm.cmd test -- test/answers/grounded-generators.test.ts
```

Expected: schema assertion fails because production still requires `claims`.

- [ ] **Step 3: Replace only the Workers AI schema**

Do not change model, temperature, token bound, response extraction, error classification, provider order, or OpenRouter JSON mode.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm.cmd test -- test/answers/grounded-generators.test.ts
git add src/answers/grounded-generators.ts test/answers/grounded-generators.test.ts
git commit -m "fix: request grounded sentence IDs"
```

### Task 3: Resolve selections server-side and preserve validation

**Files:**
- Modify: `src/answers/grounded.ts`
- Modify: `test/answers/grounded.test.ts`

**Interfaces:**
- Consumes: `buildSentenceCandidates(request.evidence)`.
- Parses: `{ sentenceIds: string[] }`.
- Produces the unchanged `GroundedAnswer` shape.
- Success event adds `selectedSentenceCount?: number`.

- [ ] **Step 1: Write RED success and injection tests**

Use evidence with multiple sentences and provider output `{"sentenceIds":["s1"]}`. Assert rendered text and `validatedClaims[0].text` exactly equal the second server-owned sentence. Assert an output with `sentenceIds` plus `answer` or `claims` fails on both attempts and never renders injected text.

- [ ] **Step 2: Write RED selection validation tests**

Assert unknown ID, duplicate ID, empty array, four IDs, non-string IDs, and extra root fields fail closed. Expect JSON/shape errors as `parse_invalid`; expect known-shape unknown/duplicate IDs as `citation_invalid`.

- [ ] **Step 3: Rewrite existing grounded fixtures to selection IDs**

Replace model-authored claim fixtures with evidence sentence selections. Preserve assertions for location, HTTPS citations, prompt injection, strict entailment defense, two attempts, provider models, conflict pruning, order invariance, all-pruned fallback, and metadata privacy. Remove tests whose only purpose was legacy `{answer,claims}` compatibility.

- [ ] **Step 4: Run RED**

```powershell
npm.cmd test -- test/answers/grounded.test.ts
```

Expected: selection tests fail because parser/prompt still require claims.

- [ ] **Step 5: Implement candidate prompt and parser**

Build candidates once before the attempt loop. Prompt JSON must contain only candidate ID, evidence ID, source metadata, and exact sentence text. Parser accepts exact root key `sentenceIds`, an array of 1-3 strings; ID existence/uniqueness is validated separately. Correction prompt says: `Return only 1 to 3 unique sentenceIds from the listed candidates.`

- [ ] **Step 6: Resolve IDs into server-owned claims**

Map each selected ID to `{ text: candidate.text, evidenceIds: [candidate.evidence.id] }`. Pass only these claims through renderable-location, strict entailment, and existing pairwise pruning. Set `selectedSentenceCount` to the number selected before pruning and `discardedClaimCount` to the pruning difference.

- [ ] **Step 7: Run GREEN and commit**

```powershell
npm.cmd test -- test/answers/evidence-sentences.test.ts test/answers/grounded-generators.test.ts test/answers/grounded.test.ts
npm.cmd run typecheck
git add src/answers/grounded.ts test/answers/grounded.test.ts
git commit -m "fix: derive grounded claims from selected sentences"
```

### Task 4: Project safe metadata and lock downstream behavior

**Files:**
- Modify: `src/telemetry/logger.ts`
- Modify: `test/logger.test.ts`
- Modify as required: `test/process-message.test.ts`
- Modify as required: `test/worker-dependencies.test.ts`
- Modify as required: `test/e2e/knowledge-search.test.ts`

**Interfaces:**
- Consumes success `selectedSentenceCount?: number` and `discardedClaimCount?: number`.
- Produces content-free telemetry and unchanged retained-only draft input.

- [ ] **Step 1: Write RED telemetry projection test**

Emit success with `selectedSentenceCount: 3` and `discardedClaimCount: 1`. Assert both numeric fields survive projection while injected question/sentence/evidence/URL/token fields do not.

- [ ] **Step 2: Run RED**

```powershell
npm.cmd test -- test/logger.test.ts
```

Expected: logger omits `selectedSentenceCount`.

- [ ] **Step 3: Add the allowlisted numeric projection**

Project `selectedSentenceCount` only in the grounded success branch, using the same conditional spread pattern as `discardedClaimCount`. Do not add it to failures or general events.

- [ ] **Step 4: Update only contract-affected integration fixtures**

Search for provider JSON containing `claims` and change grounded-generation fixtures to `sentenceIds`. Keep mocked `GroundedAnswer` fixtures unchanged because the public result API remains compatible. Retain the existing test proving discarded web sources cannot enter a draft.

- [ ] **Step 5: Run integration GREEN and commit**

```powershell
npm.cmd test -- test/logger.test.ts test/process-message.test.ts test/worker-dependencies.test.ts test/e2e/knowledge-search.test.ts
npm.cmd run typecheck
git add src/telemetry/logger.ts test/logger.test.ts test/process-message.test.ts test/worker-dependencies.test.ts test/e2e/knowledge-search.test.ts
git commit -m "test: lock sentence selection telemetry and wiring"
```

Only add files that actually changed.

### Task 5: Verify, review, deploy, and smoke

**Files:**
- Verify all commits since `6273d76`.
- Do not add diagnostic HTTP routes.

- [ ] **Step 1: Run fresh local verification**

```powershell
npm.cmd test
npm.cmd run typecheck
git diff --check
npx.cmd wrangler deploy --dry-run
```

Expected: all tests pass; types/bindings are current; dry-run lists Queue, D1, Vectorize, R2, and AI.

- [ ] **Step 2: Obtain independent security review**

Review against `docs/superpowers/specs/2026-08-09-grounded-sentence-selection-design.md`. Block deployment if provider-authored text reaches rendering, unknown IDs resolve, selection order changes conflict survivors, validation is weakened, discarded/unselected sources enter drafts, or telemetry exposes content.

- [ ] **Step 3: Deploy and health-check**

```powershell
npx.cmd wrangler deploy
Invoke-WebRequest -Uri 'https://line-running-community-bot.yamolineaichotbot.workers.dev/health' -UseBasicParsing
```

Expected: a new Version ID and HTTP 200 `{"status":"ok"}`.

- [ ] **Step 4: Run one metadata-only production smoke**

Start exactly one `wrangler tail`, ask the user to send an ordinary running question, and inspect only provider/validation/count/draft metadata. Success requires Workers AI-first, a validated sentence selection, citations, and one pending draft for a web-backed answer; OpenRouter remains unused unless Workers AI call fails.

- [ ] **Step 5: Stop tail and report honestly**

Stop the exact tail process chain whether smoke succeeds or fails. Report Version ID, providers, validation reasons, selected/discarded counts, citation presence, and draft outcome without reproducing question, answer, sentence, evidence, source, URL, payload, or identity content.
