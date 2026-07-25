# Observability and Reliability Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe structured diagnostics, Cloudflare Logs/Traces configuration, generated binding types, and an executable operations runbook so production failures can be located by `webhookEventId`.

**Architecture:** A small telemetry module owns the event schema and JSON emission. The webhook, queue consumer, answer workflow, LINE delivery, storage, and cron paths emit stable classifications through an injected logger, while existing D1 metrics remain the aggregate trend store. Wrangler enables sampled Logs/Traces and generates binding declarations from the deployment configuration.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, Workers Logs and Traces, Hono, Cloudflare Queues, D1, Workers AI, Vitest 4, Wrangler 4.

## Global Constraints

- Do not log message text, answers, LINE user IDs, group IDs, reply tokens, authorization headers, secrets, arbitrary error objects, or complete provider responses.
- Use `webhookEventId` for LINE-event correlation and `crypto.randomUUID()` for scheduled operations.
- Logs use stable JSON fields and allowlisted `errorType`/`detail` values.
- Workers Logs sampling is `1.0`; Traces sampling is `0.1`.
- D1 metrics remain the long-term aggregate store and must not receive message content.
- Existing Workers AI, Open-Meteo, LINE push fallback, bounded retry, and DLQ behavior must remain unchanged.
- Cron failures emit a classified event and rethrow.
- D1 migrations must remain backward compatible with the previously deployed Worker.
- No staging environment, gradual deployment, proactive alert, external OTel destination, or new end-user feature is included.

## File Map

- Create `src/telemetry/logger.ts`: structured event types, allowlisted classifications, serializer, and console sink.
- Create `test/logger.test.ts`: event schema, serialization, and privacy-contract tests.
- Modify `src/jobs/process-message.ts`: queue, provider, storage, LINE, retry, and completion events.
- Modify `test/process-message.test.ts`: event sequence tests for success and failure branches.
- Modify `src/index.ts`: logger injection, webhook events, queue boundary events, and cron operation events.
- Modify `test/webhook.test.ts`: webhook classification tests.
- Modify `test/worker-dependencies.test.ts`: cron success/failure and queue boundary tests.
- Modify `wrangler.jsonc`: enable Logs and Traces sampling.
- Create `worker-configuration.d.ts`: generated Wrangler binding declarations.
- Modify `src/config.ts`: compose generated production bindings with test-only `FETCHER`.
- Modify `tsconfig.json`: include the generated declaration and stop loading the generic hand-maintained Workers type bundle directly.
- Modify `package.json`: add binding-type generation and verification scripts.
- Modify `test/e2e/webhook-to-reply.test.ts`: correlation path acceptance test.
- Modify `README.md`: deployment gate and Dashboard smoke checks.
- Create `docs/operations/observability.md`: Dashboard query, manual thresholds, privacy audit, and rollback runbook.

---

### Task 1: Privacy-Safe Structured Logger

**Files:**
- Create: `src/telemetry/logger.ts`
- Create: `test/logger.test.ts`

**Interfaces:**
- Produces:
  - `type TelemetryStage = "webhook" | "queue" | "answer" | "line" | "storage" | "cron"`
  - `type TelemetryOutcome = "success" | "retry" | "fallback" | "failed"`
  - `type TelemetryErrorType`
  - `interface TelemetryEvent`
  - `interface TelemetryLogger { emit(event: TelemetryEvent): void }`
  - `createConsoleTelemetryLogger(write?: (line: string) => void): TelemetryLogger`

- [ ] **Step 1: Write the failing logger tests**

Create `test/logger.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createConsoleTelemetryLogger, type TelemetryEvent } from "../src/telemetry/logger";

describe("structured telemetry logger", () => {
  it("writes one JSON object with stable correlation fields", () => {
    const write = vi.fn();
    const logger = createConsoleTelemetryLogger(write);

    logger.emit({
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      intent: "weather",
      model: "open-meteo",
      durationMs: 125,
    });

    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      event: "question.completed",
      stage: "queue",
      outcome: "success",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      intent: "weather",
      model: "open-meteo",
      durationMs: 125,
    });
  });

  it("does not expose arbitrary fields through the event contract", () => {
    const event = {
      event: "line.reply.failed",
      stage: "line",
      outcome: "fallback",
      webhookEventId: "event-1",
      timestamp: "2026-07-25T10:00:00.000Z",
      errorType: "line_reply_failed",
    } satisfies TelemetryEvent;

    expect(Object.keys(event)).not.toEqual(
      expect.arrayContaining(["question", "answer", "userId", "groupId", "replyToken", "error"]),
    );
  });
});
```

- [ ] **Step 2: Run the logger tests and verify RED**

Run:

```powershell
npm.cmd test -- test/logger.test.ts
```

Expected: FAIL because `src/telemetry/logger.ts` does not exist.

- [ ] **Step 3: Implement the logger contract**

Create `src/telemetry/logger.ts`:

```ts
export type TelemetryStage = "webhook" | "queue" | "answer" | "line" | "storage" | "cron";
export type TelemetryOutcome = "success" | "retry" | "fallback" | "failed";

export type TelemetryErrorType =
  | "invalid_signature"
  | "invalid_json"
  | "queue_unavailable"
  | "lease_unavailable"
  | "storage_unavailable"
  | "ai_rate_limited"
  | "ai_timeout"
  | "ai_provider_error"
  | "weather_timeout"
  | "weather_provider_error"
  | "line_reply_failed"
  | "line_push_failed"
  | "cron_cleanup_failed"
  | "unexpected_error";

export interface TelemetryEvent {
  event: string;
  stage: TelemetryStage;
  outcome: TelemetryOutcome;
  timestamp: string;
  webhookEventId?: string;
  operationId?: string;
  intent?: "general" | "weather";
  model?: string | null;
  durationMs?: number;
  retryDelaySeconds?: number;
  errorType?: TelemetryErrorType;
  detail?: "primary_model" | "fallback_model" | "reply" | "push" | "reused_prepared";
}

export interface TelemetryLogger {
  emit(event: TelemetryEvent): void;
}

export function createConsoleTelemetryLogger(
  write: (line: string) => void = (line) => console.log(line),
): TelemetryLogger {
  return {
    emit(event) {
      write(JSON.stringify(event));
    },
  };
}
```

- [ ] **Step 4: Run logger tests and type checking**

Run:

```powershell
npm.cmd test -- test/logger.test.ts
npm.cmd run typecheck
```

Expected: 2 logger tests PASS and type checking exits 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/telemetry/logger.ts test/logger.test.ts
git commit -m "feat: add structured telemetry logger"
```

---

### Task 2: Instrument the Question Processing Workflow

**Files:**
- Modify: `src/jobs/process-message.ts`
- Modify: `test/process-message.test.ts`

**Interfaces:**
- Consumes: `TelemetryLogger` and `TelemetryEvent` from Task 1.
- Extends: `ProcessDependencies` with `logger?: TelemetryLogger`.
- Produces: stable events for claim, provider selection/failure, storage, LINE fallback, retry, and final completion.

- [ ] **Step 1: Add a failing successful-flow event sequence test**

In `test/process-message.test.ts`, add a logger collector to the existing successful fixture:

```ts
const events: TelemetryEvent[] = [];
const logger: TelemetryLogger = { emit: (event) => events.push(event) };
```

Pass `logger` in `ProcessDependencies`, then assert:

```ts
expect(events.map((event) => event.event)).toEqual([
  "question.started",
  "answer.completed",
  "line.reply.completed",
  "question.completed",
]);
expect(events.at(-1)).toMatchObject({
  stage: "queue",
  outcome: "success",
  webhookEventId: job.webhookEventId,
  intent: "general",
});
```

Import the interfaces:

```ts
import type { TelemetryEvent, TelemetryLogger } from "../src/telemetry/logger";
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the exact test name introduced in Step 1:

```powershell
npm.cmd test -- test/process-message.test.ts -t "emits the successful processing sequence"
```

Expected: FAIL because `ProcessDependencies` has no logger and no events are emitted.

- [ ] **Step 3: Add the logger dependency and common emitter**

In `src/jobs/process-message.ts`, import the logger:

```ts
import { AnswerUnavailableError } from "../answers/openrouter";
import type { TelemetryEvent, TelemetryLogger } from "../telemetry/logger";
```

Extend `ProcessDependencies`:

```ts
logger?: TelemetryLogger;
```

Add a helper:

```ts
function answerErrorType(
  intent: "general" | "weather",
  error: unknown,
): TelemetryEvent["errorType"] {
  if (intent === "weather") {
    return error instanceof DOMException && error.name === "AbortError"
      ? "weather_timeout"
      : "weather_provider_error";
  }
  if (error instanceof AnswerUnavailableError) {
    if (error.reason === "rate_limited") return "ai_rate_limited";
    if (error.reason === "timeout") return "ai_timeout";
  }
  return "ai_provider_error";
}

function emit(
  logger: TelemetryLogger | undefined,
  event: Omit<TelemetryEvent, "timestamp">,
  now?: () => Date,
): void {
  logger?.emit({ ...event, timestamp: (now?.() ?? new Date()).toISOString() });
}
```

At the start of `processQuestion`, emit:

```ts
emit(dependencies.logger, {
  event: "question.started",
  stage: "queue",
  outcome: "success",
  webhookEventId: job.webhookEventId,
  intent: metricIntent,
}, dependencies.now);
```

After a provider answer succeeds, emit:

```ts
emit(dependencies.logger, {
  event: "answer.completed",
  stage: "answer",
  outcome: "success",
  webhookEventId: job.webhookEventId,
  intent: metricIntent,
  model: answer.model,
}, dependencies.now);
```

After LINE reply succeeds, emit `line.reply.completed`. Immediately before each successful return, emit `question.completed` with the final model, intent, status-derived outcome, and `elapsedMs`.

- [ ] **Step 4: Run the successful-flow test and verify GREEN**

```powershell
npm.cmd test -- test/process-message.test.ts -t "emits the successful processing sequence"
```

Expected: PASS.

- [ ] **Step 5: Add failing tests for classified failure and fallback events**

Add focused tests using existing fixtures:

```ts
expect(events).toEqual(expect.arrayContaining([
  expect.objectContaining({
    event: "line.reply.failed",
    stage: "line",
    outcome: "fallback",
    errorType: "line_reply_failed",
  }),
  expect.objectContaining({
    event: "line.push.completed",
    stage: "line",
    outcome: "success",
  }),
]));
```

For a D1 claim rejection:

```ts
expect(events.at(-1)).toMatchObject({
  event: "question.retry",
  stage: "storage",
  outcome: "retry",
  errorType: "lease_unavailable",
  retryDelaySeconds: 1,
});
```

For both LINE delivery methods failing:

```ts
expect(events).toEqual(expect.arrayContaining([
  expect.objectContaining({
    event: "line.push.failed",
    errorType: "line_push_failed",
    outcome: "failed",
  }),
]));
```

- [ ] **Step 6: Run the new failure tests and verify RED**

```powershell
npm.cmd test -- test/process-message.test.ts -t "emits classified"
```

Expected: FAIL because the classified failure events are absent.

- [ ] **Step 7: Emit events at each existing decision point**

Add emissions without changing return dispositions:

- claim exception: `question.retry`, `storage`, `lease_unavailable`, delay `1`;
- busy lease: `question.retry`, `storage`, `lease_unavailable`, computed delay;
- answer exception: `answer.failed`, `answer`, with `answerErrorType(metricIntent, error)`;
- prepare/complete exception: `question.retry`, `storage`, `storage_unavailable`;
- reply failure: `line.reply.failed`, `line`, `fallback`, `line_reply_failed`;
- push success: `line.push.completed`;
- push failure: `line.push.failed`, `line`, `failed`, `line_push_failed`;
- final completion: `question.completed`.

Do not pass caught error objects or messages into `emit`.

- [ ] **Step 8: Run process tests and type checking**

```powershell
npm.cmd test -- test/process-message.test.ts
npm.cmd run typecheck
```

Expected: all process-message tests PASS and type checking exits 0.

- [ ] **Step 9: Commit Task 2**

```powershell
git add src/jobs/process-message.ts test/process-message.test.ts
git commit -m "feat: trace question processing outcomes"
```

---

### Task 3: Instrument Webhook, Queue Boundary, and Cron

**Files:**
- Modify: `src/index.ts`
- Modify: `test/webhook.test.ts`
- Modify: `test/worker-dependencies.test.ts`

**Interfaces:**
- Consumes: `TelemetryLogger` and `createConsoleTelemetryLogger` from Task 1.
- Extends: `WorkerDependencies` with `logger?: TelemetryLogger`.
- Produces: webhook classifications, queue boundary classifications, and cron operation events.

- [ ] **Step 1: Write failing webhook classification tests**

In `test/webhook.test.ts`, inject:

```ts
const events: TelemetryEvent[] = [];
const worker = createWorker({ logger: { emit: (event) => events.push(event) } });
```

For a missing or invalid signature, assert:

```ts
expect(events.at(-1)).toMatchObject({
  event: "webhook.rejected",
  stage: "webhook",
  outcome: "failed",
  errorType: "invalid_signature",
});
```

For invalid JSON with a valid signature, assert `errorType: "invalid_json"`. For queue send failure, assert `event: "webhook.enqueue.failed"` and `errorType: "queue_unavailable"`.

- [ ] **Step 2: Run webhook tests and verify RED**

```powershell
npm.cmd test -- test/webhook.test.ts -t "telemetry"
```

Expected: FAIL because `WorkerDependencies` has no logger and webhook events are absent.

- [ ] **Step 3: Inject and use the logger in `createWorker`**

In `src/index.ts`:

```ts
import { createConsoleTelemetryLogger, type TelemetryLogger } from "./telemetry/logger";
```

Extend `WorkerDependencies`:

```ts
logger?: TelemetryLogger;
```

Inside `createWorker`:

```ts
const logger = overrides.logger ?? createConsoleTelemetryLogger();
const timestamp = () => (overrides.now?.() ?? new Date()).toISOString();
```

Emit the exact classifications asserted in Step 1. Never log the body, signature, user, group, or token. Pass `logger` into `ProcessDependencies`.

- [ ] **Step 4: Run webhook tests and verify GREEN**

```powershell
npm.cmd test -- test/webhook.test.ts
```

Expected: all webhook tests PASS.

- [ ] **Step 5: Write failing cron tests**

In `test/worker-dependencies.test.ts`, inject a collector and assert successful purge:

```ts
expect(events.map((event) => event.event)).toEqual([
  "cron.cleanup.started",
  "cron.cleanup.completed",
]);
expect(events[0]?.operationId).toEqual(expect.any(String));
expect(events[1]).toMatchObject({ stage: "cron", outcome: "success" });
```

Add a failure test where `purgeExpired` rejects and assert:

```ts
await expect(worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)).rejects.toThrow("D1 unavailable");
expect(events.at(-1)).toMatchObject({
  event: "cron.cleanup.failed",
  stage: "cron",
  outcome: "failed",
  errorType: "cron_cleanup_failed",
});
```

- [ ] **Step 6: Run cron tests and verify RED**

```powershell
npm.cmd test -- test/worker-dependencies.test.ts -t "cron telemetry"
```

Expected: FAIL because cron events are absent.

- [ ] **Step 7: Implement cron correlation and rethrow**

Wrap scheduled cleanup:

```ts
async scheduled(_controller, env) {
  const operationId = crypto.randomUUID();
  logger.emit({
    event: "cron.cleanup.started",
    stage: "cron",
    outcome: "success",
    operationId,
    timestamp: timestamp(),
  });
  try {
    await questionsFor(env).purgeExpired(timestamp());
    logger.emit({
      event: "cron.cleanup.completed",
      stage: "cron",
      outcome: "success",
      operationId,
      timestamp: timestamp(),
    });
  } catch {
    logger.emit({
      event: "cron.cleanup.failed",
      stage: "cron",
      outcome: "failed",
      operationId,
      timestamp: timestamp(),
      errorType: "cron_cleanup_failed",
    });
    throw new Error("scheduled cleanup failed");
  }
},
```

The failure test should assert the stable replacement error text, not the original provider error.

- [ ] **Step 8: Add queue boundary coverage**

In `test/worker-dependencies.test.ts`, assert an unexpected `processQuestion` exception produces:

```ts
expect(events.at(-1)).toMatchObject({
  event: "queue.message.retry",
  stage: "queue",
  outcome: "retry",
  webhookEventId: job.webhookEventId,
  retryDelaySeconds: 1,
  errorType: "unexpected_error",
});
```

Implement this emission in the queue handler catch without logging the exception.

- [ ] **Step 9: Run all boundary tests and type checking**

```powershell
npm.cmd test -- test/webhook.test.ts test/worker-dependencies.test.ts
npm.cmd run typecheck
```

Expected: all focused tests PASS and type checking exits 0.

- [ ] **Step 10: Commit Task 3**

```powershell
git add src/index.ts test/webhook.test.ts test/worker-dependencies.test.ts
git commit -m "feat: trace worker boundaries and cleanup"
```

---

### Task 4: Enable Observability and Generate Binding Types

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `package.json`
- Create: `worker-configuration.d.ts`
- Modify: `src/config.ts`
- Modify: `tsconfig.json`
- Modify: `test/worker-dependencies.test.ts`

**Interfaces:**
- Produces: generated global `Env` bindings from `wrangler.jsonc`.
- Preserves: exported `Env` alias from `src/config.ts` for existing imports.

- [ ] **Step 1: Add a failing configuration contract test**

In `test/worker-dependencies.test.ts`, import the config as raw text:

```ts
import wranglerConfig from "../wrangler.jsonc?raw";
```

Add:

```ts
it("enables production logs and sampled traces", () => {
  const config = JSON.parse(wranglerConfig);
  expect(config.observability).toEqual({
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1 },
    traces: { enabled: true, head_sampling_rate: 0.1 },
  });
});
```

- [ ] **Step 2: Run the config test and verify RED**

```powershell
npm.cmd test -- test/worker-dependencies.test.ts -t "sampled traces"
```

Expected: FAIL because `observability` is absent.

- [ ] **Step 3: Add the observability configuration**

Add to `wrangler.jsonc`:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "head_sampling_rate": 1 },
  "traces": { "enabled": true, "head_sampling_rate": 0.1 }
},
```

- [ ] **Step 4: Run config test and Wrangler dry-run**

```powershell
npm.cmd test -- test/worker-dependencies.test.ts -t "sampled traces"
npm.cmd run deploy -- --dry-run
```

Expected: test PASS; dry-run exits 0 and lists `MESSAGE_QUEUE`, `DB`, and `AI`.

- [ ] **Step 5: Add type generation scripts**

Modify `package.json` scripts:

```json
"types:bindings": "wrangler types worker-configuration.d.ts --env-interface WorkerEnv",
"types:bindings:check": "wrangler types worker-configuration.d.ts --env-interface WorkerEnv --check",
"typecheck": "npm run types:bindings:check && tsc --noEmit"
```

Run:

```powershell
npm.cmd run types:bindings
```

Expected: `worker-configuration.d.ts` is created from `wrangler.jsonc`.

- [ ] **Step 6: Compose production and test-only bindings**

Replace the handwritten binding declarations in `src/config.ts` with:

```ts
import type { Fetcher } from "./line/client";

export type Env = WorkerEnv & {
  FETCHER?: Fetcher;
};
```

Update `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["worker-configuration.d.ts", "src", "test"]
}
```

The scripts explicitly generate the global `WorkerEnv` interface; do not duplicate its fields manually.

- [ ] **Step 7: Verify generated type drift detection**

```powershell
npm.cmd run types:bindings:check
npm.cmd run typecheck
```

Expected: both commands exit 0.

Temporarily rename the `AI` binding in an uncommitted edit to `AI_TEST`, run `npm.cmd run types:bindings:check`, and require a non-zero exit. Restore `wrangler.jsonc` immediately and rerun the command successfully.

- [ ] **Step 8: Run the full suite and dry-run**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

Expected: all tests PASS, type checking exits 0, and dry-run exits 0.

- [ ] **Step 9: Commit Task 4**

```powershell
git add wrangler.jsonc package.json worker-configuration.d.ts src/config.ts tsconfig.json test/worker-dependencies.test.ts
git commit -m "chore: enable workers observability"
```

---

### Task 5: Operations Runbook and End-to-End Acceptance

**Files:**
- Create: `docs/operations/observability.md`
- Modify: `README.md`
- Modify: `test/e2e/webhook-to-reply.test.ts`

**Interfaces:**
- Consumes: structured event names from Tasks 2 and 3.
- Produces: an operator-executable Dashboard inspection, privacy audit, deployment, and rollback procedure.

- [ ] **Step 1: Add a failing end-to-end correlation test**

In the E2E fixture, collect telemetry:

```ts
const events: TelemetryEvent[] = [];
const worker = createWorker({
  fetcher,
  now: () => new Date("2026-07-18T00:00:00.000Z"),
  answerService,
  logger: { emit: (event) => events.push(event) },
});
```

After webhook delivery and queue consumption, assert:

```ts
const correlated = events.filter((entry) => entry.webhookEventId === "event-e2e-1");
expect(correlated.map((entry) => entry.event)).toEqual(expect.arrayContaining([
  "webhook.enqueue.completed",
  "question.started",
  "answer.completed",
  "line.reply.completed",
  "question.completed",
]));
expect(JSON.stringify(correlated)).not.toContain("@running-bot");
expect(JSON.stringify(correlated)).not.toContain("line-user-1");
expect(JSON.stringify(correlated)).not.toContain("reply-e2e-1");
```

- [ ] **Step 2: Run E2E test and verify RED**

```powershell
npm.cmd test -- test/e2e/webhook-to-reply.test.ts -t "correlates"
```

Expected: FAIL until `webhook.enqueue.completed` and the complete correlated sequence are emitted.

- [ ] **Step 3: Add any missing enqueue completion event**

In `src/index.ts`, after a successful queue send:

```ts
logger.emit({
  event: "webhook.enqueue.completed",
  stage: "webhook",
  outcome: "success",
  webhookEventId: job.webhookEventId,
  timestamp: timestamp(),
});
```

Do not add message, user, group, or token fields.

- [ ] **Step 4: Run E2E test and verify GREEN**

```powershell
npm.cmd test -- test/e2e/webhook-to-reply.test.ts -t "correlates"
```

Expected: PASS.

- [ ] **Step 5: Write the observability runbook**

Create `docs/operations/observability.md` with these exact sections:

```markdown
# Observability operations

## Privacy contract

Normal logs may contain event names, stage, outcome, `webhookEventId`, intent,
model, duration, retry delay, and allowlisted classifications. They must not
contain message or answer text, LINE user/group IDs, reply tokens, credentials,
authorization headers, or raw provider errors.

## Dashboard inspection

1. Open Cloudflare Dashboard > Workers & Pages > line-running-community-bot.
2. Open Observability > Logs and search the exact `webhookEventId`.
3. Confirm the ordered webhook, queue, answer, LINE, storage, and completion
   events.
4. Open Traces for slow or failed invocations and compare `durationMs`.
5. Open Queues metrics for line-question-jobs and inspect backlog, oldest
   message age, retry outcomes, and DLQ outcomes.
6. Query D1 metrics for daily outcome and latency trends.

## Manual investigation triggers

- Backlog grows continuously or oldest message age exceeds two minutes.
- `provider_unavailable` or `reply_failed` repeats in a short period.
- Fallback frequency is visibly above the established daily baseline.
- The daily cleanup completion event is absent.
- A forbidden privacy field appears in any normal log.

## Production smoke check

1. Require `/health` HTTP 200 with `{"status":"ok"}`.
2. Send one harmless LINE-native mention in the allowed group.
3. Require exactly one visible answer.
4. Search its `webhookEventId` and require the complete success sequence.
5. Confirm one `answered` D1 row and no message content in Logs/Traces.
6. Confirm Queue backlog returns to its prior level.

## Rollback

1. Record `npx wrangler deployments list`.
2. Copy the known-good ID from `npx wrangler deployments list` into
   `$knownGoodDeploymentId`, then run
   `npx wrangler rollback $knownGoodDeploymentId --message "rollback after failed smoke"`.
3. Repeat the production smoke check.
4. Remember that rollback does not revert D1 migrations or resource state.
```

- [ ] **Step 6: Update README deployment gates**

Add to the verification command block:

```powershell
npm run types:bindings:check
npm test
npm run typecheck
npm run deploy -- --dry-run
```

Link `docs/operations/observability.md` from the production smoke and rollback sections. State that Logs use 100% sampling and Traces use 10% during the baseline phase.

- [ ] **Step 7: Run documentation and privacy checks**

```powershell
rg -n "webhookEventId|Queue|Logs|Traces|privacy|rollback" docs/operations/observability.md README.md
rg -n "question:|answer:|userId:|groupId:|replyToken:" src/telemetry/logger.ts
```

Expected: the first command finds every operational topic; the second returns no matches.

- [ ] **Step 8: Run final verification**

```powershell
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
git diff --check
```

Expected:

- binding type check exits 0;
- all Vitest files and tests PASS;
- TypeScript exits 0;
- Wrangler dry-run exits 0 and lists Queue, D1, and AI bindings;
- `git diff --check` prints no errors.

- [ ] **Step 9: Review acceptance criteria**

Check the implementation against every acceptance criterion in `docs/superpowers/specs/2026-07-25-observability-reliability-design.md`. Record any production-only smoke item as pending deployment; do not claim it passed from fake local endpoints.

- [ ] **Step 10: Commit Task 5**

```powershell
git add src/index.ts README.md docs/operations/observability.md test/e2e/webhook-to-reply.test.ts
git commit -m "docs: add observability operations runbook"
```
