# OpenRouter Latency and Stability Optimization Implementation Plan

> **Status:** Superseded. The final implementation migrated answer generation to Cloudflare Workers AI instead of retaining OpenRouter. This document is preserved as historical planning context and is not the current deployment specification. See `README.md` and `docs/setup/line-messaging-api.md` for current operations.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce user-visible wait time and make OpenRouter generation more resilient by trying a faster primary model first and falling back only on provider-style failures, without changing the existing response style.

**Architecture:** Keep the current webhook/queue/D1 pipeline. Change only the answer-generation layer so it accepts a primary OpenRouter model plus an optional fallback model, retries once on provider failures, and preserves the current safe degradation text if both attempts fail.

**Tech Stack:** TypeScript 5, Cloudflare Workers, Hono, Cloudflare Queues, D1, OpenRouter Chat Completions API, Vitest, Wrangler.

## Global Constraints

- Do not change the public answer style or make responses shorter.
- Do not add intermediary "working on it" messages, typing indicators, or streaming replies.
- Do not introduce a new external answer provider.
- Preserve compatibility when only `OPENROUTER_MODEL` is set.
- Keep existing webhook validation, group filtering, admin command routing, queue retry behavior, and D1 persistence unchanged.

---

### Task 1: Add fallback-aware OpenRouter tests and service contract

**Files:**
- Modify: `test/openrouter.test.ts`
- Modify: `src/answers/openrouter.ts`
- Modify: `src/answers/types.ts` only if the answer service contract needs a helper type for multiple candidates

**Interfaces:**
- Consumes: `OpenRouterAnswerService(fetcher, apiKey, model, fallbackModel?)`
- Produces: same `AnswerResult` shape as today, with `model` reflecting the model that actually answered

- [ ] **Step 1: Write the failing tests**

Add these tests to `test/openrouter.test.ts`:

```ts
it("falls back to the secondary model when the primary model returns provider_error", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("bad", { status: 503 }))
    .mockResolvedValueOnce(jsonResponse({
      model: "fallback/model",
      choices: [{ message: { content: "可以，先放鬆一下。" } }],
    }));

  await expect(
    new OpenRouterAnswerService(fetcher, "key", "primary/model", "fallback/model").answer({
      question: "question",
      locale: "zh-TW",
    }),
  ).resolves.toEqual({
    text: "可以，先放鬆一下。",
    model: "fallback/model",
    inputTokens: null,
    outputTokens: null,
  });

  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reports provider_error when both primary and fallback models fail", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("bad", { status: 503 }))
    .mockResolvedValueOnce(new Response("bad", { status: 503 }));

  await expect(
    new OpenRouterAnswerService(fetcher, "key", "primary/model", "fallback/model").answer({
      question: "question",
      locale: "zh-TW",
    }),
  ).rejects.toEqual(new AnswerUnavailableError("provider_error"));

  expect(fetcher).toHaveBeenCalledTimes(2);
});
```

Run:

```bash
npm.cmd test -- test/openrouter.test.ts
```

Expected: FAIL until fallback logic exists.

- [ ] **Step 2: Implement the minimal fallback logic**

Update `src/answers/openrouter.ts` so `OpenRouterAnswerService` keeps the current request body and timeout behavior, but iterates through `[model, fallbackModel]` in order.

Use the primary model first.
If the primary attempt throws `AnswerUnavailableError("rate_limited")`, `"provider_error"`, or `"timeout"`, retry once with the fallback model if it exists and is different from the primary model.
If the fallback also fails, rethrow `AnswerUnavailableError("provider_error")` unless one of the attempts returned `"rate_limited"` and neither produced an answer.

The request body stays the same:

```ts
{
  model,
  messages: [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: request.question },
  ],
  temperature: 0.3,
  max_tokens: 700,
}
```

Keep the parsing rules unchanged:

- accept only non-empty trimmed string content
- parse `model` and token usage from the provider response
- continue mapping HTTP 429 to `rate_limited`
- continue mapping timeouts to `timeout`
- continue mapping other provider failures to `provider_error`

- [ ] **Step 3: Re-run the OpenRouter tests**

Run:

```bash
npm.cmd test -- test/openrouter.test.ts
```

Expected: PASS, including the new fallback cases.

- [ ] **Step 4: Commit**

```bash
git add src/answers/openrouter.ts test/openrouter.test.ts
git commit -m "feat: add OpenRouter fallback model support"
```

### Task 2: Wire fallback model configuration through the worker

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `test/worker-dependencies.test.ts`
- Modify: `test/process-message.test.ts` only if the answer-service wiring needs a new assertion hook

**Interfaces:**
- Produces: `Env.OPENROUTER_FALLBACK_MODEL?: string`
- Produces: `createWorker()` passing both model names into `OpenRouterAnswerService`

- [ ] **Step 1: Write the failing wiring test**

Add a worker dependency test that injects a fake `OPENROUTER_MODEL` and `OPENROUTER_FALLBACK_MODEL` and asserts the queue consumer still works with the same repository injection path.

If you need to check the constructor wiring more directly, add a small `createWorker` test in `test/worker-dependencies.test.ts` that constructs the worker with an env containing both model names and uses a fake fetcher that returns the fallback answer only on the second call.

Example assertion shape:

```ts
expect(message.ack).toHaveBeenCalledOnce();
expect(repository.claim).toHaveBeenCalledOnce();
```

Run:

```bash
npm.cmd test -- test/worker-dependencies.test.ts test/process-message.test.ts
```

Expected: PASS for the existing repository tests, but the fallback wiring assertion should fail until `src/index.ts` passes the extra env value into the answer service.

- [ ] **Step 2: Add the config field and wire it through**

Update `src/config.ts`:

```ts
export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_GROUP_ID: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_FALLBACK_MODEL?: string;
  ANALYTICS_HASH_KEY: string;
  GROUP_ADMINS_BOOTSTRAP_JSON: string;
  MESSAGE_QUEUE: Queue<QuestionJob>;
  DB: D1Database;
  FETCHER?: Fetcher;
}
```

Update `src/index.ts` to construct:

```ts
new OpenRouterAnswerService(fetcher, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL, env.OPENROUTER_FALLBACK_MODEL)
```

Do not change any queue or webhook behavior in the same edit.

- [ ] **Step 3: Re-run the worker tests**

Run:

```bash
npm.cmd test -- test/worker-dependencies.test.ts test/process-message.test.ts test/openrouter.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/index.ts test/worker-dependencies.test.ts test/process-message.test.ts
git commit -m "feat: wire OpenRouter fallback model through worker"
```

### Task 3: Document the new setting and verify the full change

**Files:**
- Modify: `README.md`
- Modify: `docs/setup/line-messaging-api.md`
- Modify: `docs/superpowers/plans/2026-07-25-openrouter-latency-stability.md` only if the implementation reveals a mismatch with the spec

**Interfaces:**
- Produces: operator-facing guidance for `OPENROUTER_FALLBACK_MODEL`

- [ ] **Step 1: Add the operational note**

Document that:

- `OPENROUTER_MODEL` is the primary model.
- `OPENROUTER_FALLBACK_MODEL` is optional and only used after a provider-style failure on the primary model.
- The fallback is a safety net, not a parallel generation path.
- Users should keep the existing answer style unchanged when selecting models.

Example wording for the setup doc:

```md
Set `OPENROUTER_MODEL` to your fastest stable model. Optionally set `OPENROUTER_FALLBACK_MODEL` to a more reliable backup model. The bot will try the primary model first and only fall back when the primary provider fails or times out.
```

- [ ] **Step 2: Run the targeted verification**

Run:

```bash
npm.cmd test -- test/openrouter.test.ts test/worker-dependencies.test.ts test/process-message.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/setup/line-messaging-api.md
git commit -m "docs: document OpenRouter fallback model"
```

### Task 4: Final verification and release handoff

**Files:**
- No new files expected

**Interfaces:**
- Produces: a verified implementation ready for deployment

- [ ] **Step 1: Run the full targeted test set**

Run:

```bash
npm.cmd test -- test/openrouter.test.ts test/worker-dependencies.test.ts test/process-message.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 2: Sanity-check the deployed behavior**

After deploy, send one normal group mention and confirm:

- a successful OpenRouter response still looks like the current style
- a forced primary-model failure reaches the fallback model
- a double failure still returns `目前服務暫時無法使用，請稍後再試。`

- [ ] **Step 3: Finish the branch**

If the verification passes, keep the implementation commit history clean and stop there; no extra refactors.
