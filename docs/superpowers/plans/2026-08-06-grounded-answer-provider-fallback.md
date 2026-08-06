# Grounded Answer Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a citation-preserving provider chain that tries the configured OpenRouter primary model, the optional OpenRouter fallback model, and Cloudflare Workers AI before reporting provider unavailability.

**Architecture:** Move provider-specific grounded generation behind a shared `GroundedGenerator` interface. A `FallbackGroundedGenerator` owns ordered failover while `GroundedAnswerService` continues to own strict JSON parsing, evidence validation, one corrective regeneration, citation rendering, and fail-closed behavior.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, Workers AI binding, Hono, Vitest 4, Wrangler 4, OpenRouter Chat Completions API.

## Global Constraints

- Keep the existing webhook, Queue, D1 schema, LINE delivery, retrieval routing, evidence ranking, and admin behavior unchanged.
- Every successful provider output must pass the existing evidence-ID, citation-location, conflict, and entailment validation.
- Never log response bodies, prompts, Authorization headers, API keys, or other secrets.
- Use the existing OpenRouter timeout of exactly `20_000` ms and clear every timer in `finally`.
- Use `@cf/meta/llama-3.2-3b-instruct` as the Workers AI grounded fallback without adding a required Secret.
- Treat `OPENROUTER_FALLBACK_MODEL` as optional and skip it when missing, blank, or equal to `OPENROUTER_MODEL`.
- Do not add dependencies or a D1 migration.

---

## File Structure

- Create `src/answers/grounded-generators.ts`: shared generator types, sanitized provider error, OpenRouter generator, Workers AI generator, and ordered fallback chain.
- Modify `src/answers/grounded.ts`: consume the shared `GroundedGenerator` type and retain only grounding, validation, and citation responsibilities.
- Modify `src/config.ts`: expose optional `OPENROUTER_FALLBACK_MODEL` in `Env`.
- Modify `src/index.ts`: assemble the three-layer production chain and inject it into `GroundedAnswerService`.
- Create `test/answers/grounded-generators.test.ts`: provider-chain unit tests.
- Modify `test/answers/grounded.test.ts`: update imports and prove Workers AI output cannot bypass citation validation.
- Modify `test/worker-dependencies.test.ts`: prove production wiring consumes both OpenRouter model settings and Workers AI.
- Modify `docs/setup/knowledge-search.md`: document primary, optional fallback, and Workers AI terminal fallback.

### Task 1: Extract the existing OpenRouter grounded generator without changing behavior

**Files:**
- Create: `src/answers/grounded-generators.ts`
- Modify: `src/answers/grounded.ts`
- Create: `test/answers/grounded-generators.test.ts`
- Modify: `test/answers/grounded.test.ts`

**Interfaces:**
- Produces: `GroundedMessage`, `GroundedGeneration`, `GroundedGenerator.generate(messages): Promise<GroundedGeneration>`.
- Produces: `GroundedProviderError(reason, status?)`, where `reason` is `http`, `timeout`, `network`, or `malformed` and no response body is retained.
- Produces: `OpenRouterGroundedGenerator(fetcher, apiKey, model)` with the same request contract as the current class.
- Consumes: no interfaces from later tasks.

- [ ] **Step 1: Write the failing extraction test**

Create `test/answers/grounded-generators.test.ts` with a successful OpenRouter request assertion and a sanitized 500 failure assertion:

```ts
import { describe, expect, it, vi } from "vitest";
import { OpenRouterGroundedGenerator } from "../../src/answers/grounded-generators";

describe("OpenRouterGroundedGenerator", () => {
  it("requests strict JSON from the configured model", async () => {
    const fetcher = vi.fn(async () => Response.json({
      model: "actual/model",
      choices: [{ message: { content: "{\"answer\":\"A\",\"claims\":[]}" } }],
    }));
    const result = await new OpenRouterGroundedGenerator(fetcher, "key", "configured/model")
      .generate([{ role: "system", content: "rules" }]);
    expect(result.model).toBe("actual/model");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({
      model: "configured/model",
      response_format: { type: "json_object" },
    });
  });

  it("does not expose a provider response body", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const generator = new OpenRouterGroundedGenerator(
      async () => new Response("secret-provider-body", { status: 500 }),
      "key",
      "configured/model",
    );
    await expect(generator.generate([{ role: "system", content: "rules" }])).rejects.toThrow();
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-provider-body");
    info.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts`

Expected: FAIL because `src/answers/grounded-generators.ts` does not exist.

- [ ] **Step 3: Add the shared interface and move the existing generator**

Create `src/answers/grounded-generators.ts` with these exported contracts and the existing OpenRouter request logic:

```ts
export type GroundedMessage = { role: "system" | "user"; content: string };
export type GroundedGeneration = { text: string; model: string };
export interface GroundedGenerator {
  generate(messages: GroundedMessage[]): Promise<GroundedGeneration>;
}

export type GroundedProviderFailureReason = "http" | "timeout" | "network" | "malformed";
export class GroundedProviderError extends Error {
  constructor(
    readonly reason: GroundedProviderFailureReason,
    readonly status?: number,
  ) {
    super(reason);
    this.name = "GroundedProviderError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OpenRouterGroundedGenerator implements GroundedGenerator {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(messages: GroundedMessage[]): Promise<GroundedGeneration> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetcher.call(globalThis, "https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, response_format: { type: "json_object" }, temperature: 0, max_tokens: 900 }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        console.info("openrouter:grounded-response", response.status);
        throw new GroundedProviderError("http", response.status);
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw new GroundedProviderError("malformed"); }
      if (typeof payload !== "object" || payload === null) throw new GroundedProviderError("malformed");
      const choices = Reflect.get(payload, "choices");
      const first = Array.isArray(choices) && typeof choices[0] === "object" && choices[0] !== null ? choices[0] : null;
      const message = first && typeof Reflect.get(first, "message") === "object" ? Reflect.get(first, "message") as object : null;
      const content = message ? Reflect.get(message, "content") : null;
      if (typeof content !== "string" || !content.trim()) throw new GroundedProviderError("malformed");
      const returnedModel = Reflect.get(payload, "model");
      return { text: content, model: typeof returnedModel === "string" && returnedModel ? returnedModel : this.model };
    } catch (error) {
      if (error instanceof GroundedProviderError) throw error;
      if (controller.signal.aborted) throw new GroundedProviderError("timeout");
      throw new GroundedProviderError("network");
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

Remove the provider class and private message/generator types from `src/answers/grounded.ts`, import `GroundedGenerator`, and change the constructor to:

```ts
constructor(
  private readonly generator: GroundedGenerator,
  private readonly entails: EntailmentChecker = strictEntailment,
) {}
```

Replace `this.generate(messages)` with `this.generator.generate(messages)`. Update `test/answers/grounded.test.ts` to import `OpenRouterGroundedGenerator` from the new file.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts test/answers/grounded.test.ts`

Expected: both files PASS with no unhandled rejection.

- [ ] **Step 5: Commit the extraction**

```powershell
git add src/answers/grounded-generators.ts src/answers/grounded.ts test/answers/grounded-generators.test.ts test/answers/grounded.test.ts
git commit -m "refactor: extract grounded provider generator"
```

### Task 2: Add OpenRouter primary and fallback sequencing

**Files:**
- Modify: `src/answers/grounded-generators.ts`
- Modify: `test/answers/grounded-generators.test.ts`

**Interfaces:**
- Consumes: `GroundedGenerator` from Task 1.
- Produces: `FallbackGroundedGenerator(generators, observe?)`.
- Produces: `GroundedProviderEvent` with `attempt.started`, `attempt.completed`, `attempt.failed`, and `fallback.started`.

- [ ] **Step 1: Write failing sequencing tests**

Add tests that prove success short-circuits and failure advances exactly once:

```ts
it("uses the fallback generator after the primary fails", async () => {
  const primary = { generate: vi.fn().mockRejectedValue(new Error("primary failed")) };
  const fallback = { generate: vi.fn().mockResolvedValue({ text: "valid", model: "fallback/model" }) };
  const events: GroundedProviderEvent[] = [];
  const chain = new FallbackGroundedGenerator([
    { provider: "openrouter", role: "primary", model: "primary/model", generator: primary },
    { provider: "openrouter", role: "fallback", model: "fallback/model", generator: fallback },
  ], (event) => events.push(event));
  await expect(chain.generate([{ role: "user", content: "q" }]))
    .resolves.toEqual({ text: "valid", model: "fallback/model" });
  expect(primary.generate).toHaveBeenCalledOnce();
  expect(fallback.generate).toHaveBeenCalledOnce();
  expect(events.map((event) => event.type)).toEqual([
    "attempt.started", "attempt.failed", "fallback.started", "attempt.started", "attempt.completed",
  ]);
});

it("does not call later generators after primary success", async () => {
  const primary = { generate: vi.fn().mockResolvedValue({ text: "valid", model: "primary/model" }) };
  const fallback = { generate: vi.fn() };
  const chain = new FallbackGroundedGenerator([
    { provider: "openrouter", role: "primary", model: "primary/model", generator: primary },
    { provider: "openrouter", role: "fallback", model: "fallback/model", generator: fallback },
  ]);
  await chain.generate([{ role: "user", content: "q" }]);
  expect(fallback.generate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts`

Expected: FAIL because `FallbackGroundedGenerator` and `GroundedProviderEvent` are not exported.

- [ ] **Step 3: Implement the minimal ordered chain**

Add these public types and class:

```ts
export type GroundedProviderRole = "primary" | "fallback" | "terminal";
export type GroundedProviderEvent = {
  type: "attempt.started" | "attempt.completed" | "attempt.failed" | "fallback.started";
  provider: "openrouter" | "workers_ai";
  role: GroundedProviderRole;
  model: string;
  durationMs?: number;
  reason?: GroundedProviderFailureReason;
  status?: number;
};

export type GroundedGeneratorEntry = {
  provider: "openrouter" | "workers_ai";
  role: GroundedProviderRole;
  model: string;
  generator: GroundedGenerator;
};

export class FallbackGroundedGenerator implements GroundedGenerator {
  constructor(
    private readonly entries: GroundedGeneratorEntry[],
    private readonly observe?: (event: GroundedProviderEvent) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!entries.length) throw new RangeError("at least one grounded generator is required");
  }

  async generate(messages: GroundedMessage[]): Promise<GroundedGeneration> {
    let terminal: unknown = new Error("grounded model unavailable");
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index]!;
      if (index > 0) this.notify({ type: "fallback.started", provider: entry.provider, role: entry.role, model: entry.model });
      const startedAt = this.safeNow();
      this.notify({ type: "attempt.started", provider: entry.provider, role: entry.role, model: entry.model });
      try {
        const result = await entry.generator.generate(messages);
        this.notify({ type: "attempt.completed", provider: entry.provider, role: entry.role, model: result.model, durationMs: Math.max(0, this.safeNow() - startedAt) });
        return result;
      } catch (error) {
        terminal = error;
        const failure = error instanceof GroundedProviderError
          ? { reason: error.reason, ...(error.status === undefined ? {} : { status: error.status }) }
          : { reason: "network" as const };
        this.notify({ type: "attempt.failed", provider: entry.provider, role: entry.role, model: entry.model, durationMs: Math.max(0, this.safeNow() - startedAt), ...failure });
      }
    }
    throw terminal;
  }

  private safeNow(): number { try { return this.now(); } catch { return Date.now(); } }
  private notify(event: GroundedProviderEvent): void { try { this.observe?.(event); } catch {} }
}
```

- [ ] **Step 4: Add table-driven failure coverage and run GREEN**

Add `it.each([400, 401, 402, 403, 404, 429, 500, 503])` around real `OpenRouterGroundedGenerator` responses and assert the next chain entry succeeds. Add an aborted-fetch test using fake timers. Run:

`npm.cmd test -- test/answers/grounded-generators.test.ts`

Expected: PASS, including all HTTP statuses and timeout.

- [ ] **Step 5: Commit the OpenRouter chain**

```powershell
git add src/answers/grounded-generators.ts test/answers/grounded-generators.test.ts
git commit -m "feat: add grounded OpenRouter fallback chain"
```

### Task 3: Add a citation-preserving Workers AI terminal generator

**Files:**
- Modify: `src/answers/grounded-generators.ts`
- Modify: `test/answers/grounded-generators.test.ts`
- Modify: `test/answers/grounded.test.ts`

**Interfaces:**
- Consumes: `GroundedMessage`, `GroundedGenerator`, and `FallbackGroundedGenerator` from Tasks 1-2.
- Produces: `WorkersAiGroundedGenerator(ai, model?)` using `@cf/meta/llama-3.2-3b-instruct` by default.

- [ ] **Step 1: Write failing Workers AI generator tests**

```ts
it("uses Workers AI after both OpenRouter layers fail", async () => {
  const ai = { run: vi.fn().mockResolvedValue({ response: "{\"answer\":\"A\",\"claims\":[]}" }) };
  const chain = new FallbackGroundedGenerator([
    { provider: "openrouter", role: "primary", model: "p", generator: { generate: vi.fn().mockRejectedValue(new Error("p")) } },
    { provider: "openrouter", role: "fallback", model: "f", generator: { generate: vi.fn().mockRejectedValue(new Error("f")) } },
    { provider: "workers_ai", role: "terminal", model: "@cf/meta/llama-3.2-3b-instruct", generator: new WorkersAiGroundedGenerator(ai) },
  ]);
  await expect(chain.generate([{ role: "system", content: "evidence" }]))
    .resolves.toMatchObject({ model: "@cf/meta/llama-3.2-3b-instruct" });
  expect(ai.run).toHaveBeenCalledWith("@cf/meta/llama-3.2-3b-instruct", expect.objectContaining({
    messages: [{ role: "system", content: "evidence" }], temperature: 0, max_tokens: 900,
  }));
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts`

Expected: FAIL because `WorkersAiGroundedGenerator` is not exported.

- [ ] **Step 3: Implement Workers AI grounded generation**

```ts
type AiBinding = Pick<Ai, "run">;
const WORKERS_AI_GROUNDED_MODEL = "@cf/meta/llama-3.2-3b-instruct";

export class WorkersAiGroundedGenerator implements GroundedGenerator {
  constructor(private readonly ai: AiBinding, private readonly model = WORKERS_AI_GROUNDED_MODEL) {}

  async generate(messages: GroundedMessage[]): Promise<GroundedGeneration> {
    const payload = await this.ai.run(this.model, { messages, temperature: 0, max_tokens: 900 }) as
      | string
      | { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    const text = typeof payload === "string"
      ? payload.trim()
      : typeof payload.response === "string"
        ? payload.response.trim()
        : typeof payload.choices?.[0]?.message?.content === "string"
          ? payload.choices[0].message.content.trim()
          : "";
    if (!text) throw new GroundedProviderError("malformed");
    return { text, model: this.model };
  }
}
```

- [ ] **Step 4: Prove Workers AI cannot bypass grounding validation**

In `test/answers/grounded.test.ts`, construct `GroundedAnswerService` with a Workers AI generator returning a claim with a missing evidence ID. Assert two correction attempts occur and the final text equals `INSUFFICIENT_EVIDENCE_TEXT`.

Run: `npm.cmd test -- test/answers/grounded-generators.test.ts test/answers/grounded.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the Workers AI terminal fallback**

```powershell
git add src/answers/grounded-generators.ts test/answers/grounded-generators.test.ts test/answers/grounded.test.ts
git commit -m "feat: add Workers AI grounded fallback"
```

### Task 4: Wire optional fallback configuration into the Worker

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `test/worker-dependencies.test.ts`

**Interfaces:**
- Consumes: all generator classes from Tasks 1-3.
- Produces: production chain built from `Env.OPENROUTER_MODEL`, optional `Env.OPENROUTER_FALLBACK_MODEL`, and `Env.AI`.

- [ ] **Step 1: Write the failing production-wiring test**

Add a test with primary 500, fallback 500, and Workers AI valid grounded JSON. Use injected repository/retriever/web search dependencies so the test reaches production generator construction. Assert:

```ts
expect(openRouterBodies.map((body) => body.model)).toEqual(["primary/model", "fallback/model"]);
expect(env.AI.run).toHaveBeenCalledWith(
  "@cf/meta/llama-3.2-3b-instruct",
  expect.objectContaining({ messages: expect.any(Array) }),
);
expect(repository.prepare).toHaveBeenCalledWith(
  expect.objectContaining({ status: "answered", model: "@cf/meta/llama-3.2-3b-instruct" }),
  "answered",
  expect.any(String),
);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm.cmd test -- test/worker-dependencies.test.ts`

Expected: FAIL because `OPENROUTER_FALLBACK_MODEL` is ignored and Workers AI is not in the grounded chain.

- [ ] **Step 3: Add optional config and assemble the chain**

Add to `Env` in `src/config.ts`:

```ts
OPENROUTER_FALLBACK_MODEL?: string;
```

Replace the single generator construction in `src/index.ts` with:

```ts
const entries: GroundedGeneratorEntry[] = [{
  provider: "openrouter",
  role: "primary",
  model: env.OPENROUTER_MODEL,
  generator: new OpenRouterGroundedGenerator(fetcher, env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL),
}];
const fallbackModel = env.OPENROUTER_FALLBACK_MODEL?.trim();
if (fallbackModel && fallbackModel !== env.OPENROUTER_MODEL) {
  entries.push({
    provider: "openrouter",
    role: "fallback",
    model: fallbackModel,
    generator: new OpenRouterGroundedGenerator(fetcher, env.OPENROUTER_API_KEY, fallbackModel),
  });
}
entries.push({
  provider: "workers_ai",
  role: "terminal",
  model: "@cf/meta/llama-3.2-3b-instruct",
  generator: new WorkersAiGroundedGenerator(env.AI),
});
const groundedGenerator = new FallbackGroundedGenerator(entries, (event) => {
  console.info("grounded:provider", event);
});
```

Pass `groundedGenerator` directly to `new GroundedAnswerService(groundedGenerator)`.

- [ ] **Step 4: Cover missing, blank, and duplicate fallback settings**

Add table-driven cases asserting only one OpenRouter attempt occurs when `OPENROUTER_FALLBACK_MODEL` is `undefined`, `""`, whitespace, or equal to the primary model; Workers AI remains the terminal layer.

Run: `npm.cmd test -- test/worker-dependencies.test.ts test/answers/grounded-generators.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit production wiring**

```powershell
git add src/config.ts src/index.ts test/worker-dependencies.test.ts
git commit -m "feat: wire grounded provider fallback chain"
```

### Task 5: Document operations and run complete verification

**Files:**
- Modify: `docs/setup/knowledge-search.md`
- Verify: `worker-configuration.d.ts`, `wrangler.jsonc`, all source and test files.

**Interfaces:**
- Consumes: completed provider chain and optional environment setting.
- Produces: operator guidance and verified deploy artifact.

- [ ] **Step 1: Update the runbook**

Add this operator guidance after the secret commands:

```md
`OPENROUTER_MODEL` is the primary grounded-answer model. `OPENROUTER_FALLBACK_MODEL` is optional; when present and different from the primary model, provider failures advance to it. Cloudflare Workers AI (`@cf/meta/llama-3.2-3b-instruct`) is always the terminal grounded fallback and still passes through citation validation.

Verify the secret names without printing their values:

```powershell
npx.cmd wrangler secret list
```
```

- [ ] **Step 2: Run focused provider tests**

Run:

```powershell
npm.cmd test -- test/answers/grounded-generators.test.ts test/answers/grounded.test.ts test/worker-dependencies.test.ts test/process-message.test.ts
```

Expected: all focused test files PASS, zero failed tests.

- [ ] **Step 3: Run knowledge and full regression gates**

Run:

```powershell
npm.cmd run test:e2e:knowledge
npm.cmd run test:quality:knowledge
npm.cmd test
npm.cmd run typecheck
npx.cmd wrangler deploy --dry-run
```

Expected: every command exits 0; Vitest reports zero failures; TypeScript reports no errors; Wrangler dry-run uploads no production version.

- [ ] **Step 4: Commit documentation**

```powershell
git add docs/setup/knowledge-search.md
git commit -m "docs: document grounded provider fallbacks"
```

- [ ] **Step 5: Deploy and verify production**

Run:

```powershell
npx.cmd wrangler deploy
curl.exe https://line-running-community-bot.yamolineaichotbot.workers.dev/health
```

Expected: deployment exits 0, prints a new version ID, and health returns `{"status":"ok"}`.

Send the known LINE smoke question once. Then run:

```powershell
npx.cmd wrangler d1 execute line-bot-diagnostics --remote --command "SELECT status,model,created_at,updated_at FROM questions ORDER BY created_at DESC LIMIT 1"
```

Expected: latest row has `status = answered`, a non-null `model`, and timestamps from the smoke-test window.
