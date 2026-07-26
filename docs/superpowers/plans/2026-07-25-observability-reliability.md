# Observability and Reliability Baseline Implementation Plan

> **Execution note:** This plan was amended on 2026-07-26 after final review.
> It reflects the implemented interfaces and acceptance tests. The controller
> owns Git index writes; agents executing this plan do not commit.

**Goal:** Deliver privacy-safe, independently indexed structured Logs,
complete transition telemetry, generated binding types, and an executable
deployment/runbook contract so production failures can be reconstructed by one
correlation identifier.

**Architecture:** `src/telemetry/logger.ts` owns a closed event catalog,
mutually exclusive correlation union, allowlisted object projection, and
best-effort console sink. Webhook, admin, queue, answer, LINE, storage, and
cron paths emit stable events through an injected logger. Provider services
expose safe typed observation events rather than raw errors. D1 remains the
aggregate trend store.

**Platform policy:** Workers Logs are enabled at `1.0`. Cloudflare Traces are
disabled for phase one because automatic external-fetch spans may expose
user-derived URL query values. Future trace enablement requires a reviewed
privacy-safe external-request boundary. A proxy Worker is not included.

**Tech stack:** Node.js 22+, TypeScript 5.9, Cloudflare Workers, Workers Logs,
Hono, Queues, D1, Workers AI, Vitest 4, and Wrangler 4.

## Global constraints

- Do not log message/answer text, LINE user/group IDs, reply tokens,
  authorization headers, access tokens, secrets, raw errors, or provider
  responses.
- `LINE_GROUP_ID=__DISCOVER__` is the sole temporary group-ID exception and is
  not a normal structured event.
- Every telemetry event has exactly one of `webhookEventId` or `operationId`.
- Parsed LINE events use `webhookEventId`; pre-parse rejection and cron use
  `operationId`; cron preserves `crypto.randomUUID()`.
- `event`, `errorType`, and `detail` use closed vocabularies.
- The production writer receives an allowlisted plain object.
- Telemetry projection/writer failure never changes processing.
- Every retry disposition ends with a retry event carrying the same delay.
- Provider and cron terminal events include `durationMs`.
- D1 migrations remain compatible with the previously deployed Worker.
- Production smoke remains pending until a real deployment.

## Final file map

- `src/telemetry/logger.ts`: event catalog, types, projection, console sink.
- `src/answers/types.ts`: typed provider observation events.
- `src/answers/openrouter.ts`: primary/fallback observation callbacks.
- `src/weather/openmeteo.ts`: weather cache storage classifications.
- `src/jobs/process-message.ts`: queue/provider/storage/LINE transitions.
- `src/index.ts`: webhook/admin/enqueue/queue-boundary/cron events.
- `wrangler.jsonc`: Logs enabled, Traces disabled.
- `worker-configuration.d.ts`: generated binding/runtime declarations.
- `src/config.ts`: production bindings plus test-only `FETCHER`.
- `package.json` and `package-lock.json`: binding scripts, Node requirement,
  removal of the unused direct Workers type bundle.
- `test/**/*.test.ts`: logger, boundary, provider, storage, and exact-sequence
  coverage.
- `README.md`: safe deployment and production handoff.
- `docs/operations/observability.md`: Query Builder, event flows, privacy,
  migration, smoke, version, and rollback operations.

---

## Task 1: Structured logger and correlation invariant

**Files**

- Modify `src/telemetry/logger.ts`.
- Modify `test/logger.test.ts`.

### Required interfaces

The event name is derived from an immutable catalog:

```ts
export const TELEMETRY_EVENT_NAMES = [
  "webhook.rejected",
  "webhook.enqueue.completed",
  "webhook.enqueue.failed",
  "admin.reply.completed",
  "admin.reply.failed",
  "question.started",
  "question.deduplicated",
  "question.retry",
  "question.completed",
  "storage.claim.completed",
  "storage.claim.failed",
  "storage.prepare.completed",
  "storage.prepare.failed",
  "storage.complete.completed",
  "storage.complete.failed",
  "storage.release.failed",
  "answer.ai.attempt.started",
  "answer.ai.attempt.completed",
  "answer.ai.attempt.failed",
  "answer.ai.fallback.started",
  "answer.prepared.reused",
  "answer.completed",
  "answer.failed",
  "weather.settings.failed",
  "line.reply.completed",
  "line.reply.failed",
  "line.push.completed",
  "line.push.failed",
  "queue.message.retry",
  "cron.cleanup.started",
  "cron.cleanup.completed",
  "cron.cleanup.failed",
] as const;
```

Correlation is required and mutually exclusive:

```ts
type TelemetryCorrelation =
  | { webhookEventId: string; operationId?: never }
  | { operationId: string; webhookEventId?: never };

export type TelemetryEvent = TelemetryFields & TelemetryCorrelation;
```

The writer contract is object-based:

```ts
export function createConsoleTelemetryLogger(
  write: (record: TelemetryRecord) => void = (record) => console.log(record),
): TelemetryLogger;
```

Projection constructs a new record from allowlisted fields and throws when a
runtime caller bypasses typing without a correlation identifier. `emit`
catches projection and writer failures.

### TDD checklist

- [ ] RED: object writer expectation fails against the previous sink.
- [ ] GREEN: the injected writer receives one plain allowlisted object.
- [ ] RED: runtime-added forbidden properties survive the previous serializer.
- [ ] GREEN: `question`, `answer`, `userId`, `groupId`, `replyToken`,
  `authorization`, `accessToken`, `secret`, and `error` are absent.
- [ ] Add a compile-time assertion that the forbidden-key intersection with
  `TelemetryEvent` is `never`.
- [ ] Verify a valid `webhookEventId` event.
- [ ] Verify a valid `operationId` event.
- [ ] Verify missing and dual identifiers fail type checking.
- [ ] Verify a malformed runtime event does not reach the writer.
- [ ] Verify a throwing writer does not escape `emit`.
- [ ] Verify every catalog name remains stable.

Run:

```powershell
npm.cmd test -- test/logger.test.ts
npm.cmd run typecheck
```

---

## Task 2: Provider observation and safe classification

**Files**

- Modify `src/answers/types.ts`.
- Modify `src/answers/openrouter.ts`.
- Modify `src/weather/openmeteo.ts`.
- Modify `test/openrouter.test.ts`.
- Modify `test/weather.test.ts`.

### Workers AI observer

`AnswerService.answer` accepts an optional best-effort
`AnswerProviderObserver`. The observer receives only:

```ts
type AnswerProviderEvent =
  | {
      type: "attempt.started";
      provider: "workers_ai";
      role: "primary" | "fallback";
      model: string;
    }
  | {
      type: "attempt.completed";
      provider: "workers_ai";
      role: "primary" | "fallback";
      model: string;
      durationMs: number;
    }
  | {
      type: "attempt.failed";
      provider: "workers_ai";
      role: "primary" | "fallback";
      model: string;
      reason: "rate_limited" | "provider_error" | "timeout";
      durationMs: number;
    }
  | {
      type: "fallback.started";
      provider: "workers_ai";
      role: "fallback";
      model: string;
      reason: "rate_limited" | "provider_error" | "timeout";
    };
```

The provider catches observer failures so observability cannot alter answer
selection.

### Weather storage boundary

Weather cache read/write failures are surfaced through the safe typed
`storage.failed` callback and mapped to `weather.cache.failed`:

- `storage_unavailable` + `weather_cache_read`;
- `storage_unavailable` + `weather_cache_write`.

Caching is optional: cache-read failure continues to Open-Meteo, and
cache-write failure returns the already valid provider answer. Neither path
returns `provider_unavailable` or a retry.

Group-settings failures remain
`weather.settings.failed/storage_unavailable/weather_settings`. Provider
timeout/failure remains `weather_timeout` or `weather_provider_error`.

### TDD checklist

- [ ] Primary success reports start and completion with model and duration.
- [ ] Primary failure reports a safe reason and duration.
- [ ] Fallback selection reports the safe triggering reason.
- [ ] Fallback success reports its own start and completion.
- [ ] Observer failure does not change the provider result.
- [ ] Weather timeout is distinct from provider failure.
- [ ] Cache read/write failures are distinct from weather provider failures,
      preserve answer success, and emit safe storage telemetry.
- [ ] No provider event contains question text or a raw caught error.

Run:

```powershell
npm.cmd test -- test/openrouter.test.ts test/weather.test.ts
npm.cmd run typecheck
```

---

## Task 3: Question-processing transition semantics

**Files**

- Modify `src/jobs/process-message.ts`.
- Modify `test/process-message.test.ts`.

### Required success flows

Generic injected-service success:

```text
question.started
storage.claim.completed
answer.completed
storage.prepare.completed
line.reply.completed
storage.complete.completed
question.completed
```

Production primary success inserts:

```text
answer.ai.attempt.started
answer.ai.attempt.completed
```

before `answer.completed`.

Production fallback success inserts:

```text
answer.ai.attempt.started        primary
answer.ai.attempt.failed         primary
answer.ai.fallback.started
answer.ai.attempt.started        fallback
answer.ai.attempt.completed      fallback
answer.completed
```

Prepared reuse:

```text
question.started
storage.claim.completed
answer.prepared.reused
line.reply.completed
storage.complete.completed
question.completed
```

Completed duplicate:

```text
question.started
storage.claim.completed
question.deduplicated
```

### Required storage and retry behavior

- Claim success emits `storage.claim.completed`, including busy/completed
  results.
- Claim exception emits `storage.claim.failed` and terminates with
  `question.retry`.
- Prepare success/failure emits `storage.prepare.completed/failed`.
- Complete success/failure emits `storage.complete.completed/failed`.
- Release failure emits `storage.release.failed` without swallowing the final
  retry event.
- Every returned retry disposition is created through one helper that emits
  `question.retry` with `retryDelaySeconds`.

### Required LINE behavior

Reply-to-push success contains:

```text
line.reply.failed
line.push.completed
storage.complete.completed
question.completed
```

Both delivery methods failing ends with:

```text
line.reply.failed
line.push.failed
storage.complete.completed | storage.complete.failed
question.retry
```

The final retry delay is present even when storage completion also fails.

### Duration behavior

- AI attempt terminal events carry attempt duration.
- `answer.completed` and `answer.failed` carry provider-stage duration.
- `question.completed` and `question.deduplicated` carry attempt duration.

### TDD checklist

- [ ] Assert every sequence above in exact order.
- [ ] Assert primary/fallback model role and safe fallback reason.
- [ ] Assert weather timeout/provider/storage classifications separately.
- [ ] Assert claim/prepare/complete success events.
- [ ] Assert claim/prepare/complete/release failure events.
- [ ] Assert prepared reuse contains no new provider/prepare event.
- [ ] Assert completed duplicate contains no new completion outcome.
- [ ] Assert reply-to-push success.
- [ ] Assert reply-plus-push failure ends in retry with delay.
- [ ] Assert raw question, answer, identity, token, and caught error data are
  absent from collected events.

Run:

```powershell
npm.cmd test -- test/process-message.test.ts
npm.cmd run typecheck
```

---

## Task 4: Webhook, admin, queue boundary, and cron

**Files**

- Modify `src/index.ts`.
- Modify `test/webhook.test.ts`.
- Modify `test/admin/webhook.test.ts`.
- Modify `test/worker-dependencies.test.ts`.
- Modify `test/e2e/webhook-to-reply.test.ts`.

### Webhook correlation

- Generate a request operation identifier before signature/body validation.
- Missing signature, invalid signature, and invalid JSON emit
  `webhook.rejected` with that identifier.
- Successful enqueue emits `webhook.enqueue.completed` with the job's
  `webhookEventId`.
- Enqueue failure emits `webhook.enqueue.failed` with the same job identifier.

### Admin path

Synchronous admin LINE replies emit `admin.reply.completed` or
`admin.reply.failed`. Use the LINE event ID when present; otherwise generate an
operation identifier. Failure is classified as `line_reply_failed`.

### Queue boundary

An unexpected exception outside the classified process flow retries the
message and emits `queue.message.retry` with the job identifier,
`unexpected_error`, and the exact retry delay.

### Cron

One `crypto.randomUUID()` identifier connects:

```text
cron.cleanup.started
cron.cleanup.completed | cron.cleanup.failed
```

Both terminal variants contain `durationMs`. Failure contains
`cron_cleanup_failed` and rethrows a stable replacement error.

### TDD checklist

- [ ] Pre-auth and pre-parse rejection require `operationId`.
- [ ] Enqueue completion/failure require the job `webhookEventId`.
- [ ] Admin reply success/failure are correlated and privacy-safe.
- [ ] Unexpected queue retry contains delay and classification.
- [ ] Cron terminals share one operation identifier and contain duration.
- [ ] Cron failure rethrows only stable text.
- [ ] End-to-end correlation begins with `webhook.enqueue.completed` and
  continues through the complete generic success sequence.

Run:

```powershell
npm.cmd test -- test/webhook.test.ts test/admin/webhook.test.ts test/worker-dependencies.test.ts test/e2e/webhook-to-reply.test.ts
npm.cmd run typecheck
```

---

## Task 5: Cloudflare configuration, generated bindings, and package cleanup

**Files**

- Modify `wrangler.jsonc`.
- Modify `test/worker-dependencies.test.ts`.
- Modify `package.json`.
- Modify `package-lock.json`.
- Verify `worker-configuration.d.ts`, `src/config.ts`, and `tsconfig.json`.

### Required configuration

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "head_sampling_rate": 1 },
  "traces": { "enabled": false }
}
```

Use Wrangler's comment-tolerant configuration reader in the contract test:

```ts
import { unstable_readConfig } from "wrangler";

const config = unstable_readConfig({ config: "wrangler.jsonc" });
expect(config.observability).toEqual({
  enabled: true,
  logs: { enabled: true, head_sampling_rate: 1 },
  traces: { enabled: false },
});
```

### Binding and package requirements

- Keep:
  - `types:bindings`;
  - `types:bindings:check`;
  - `typecheck` invoking the drift check before TypeScript.
- Keep generated runtime declarations in `worker-configuration.d.ts`.
- Keep test-only `FETCHER` composition separate from `WorkerEnv`.
- Remove the unused direct `@cloudflare/workers-types` devDependency through
  npm and update the lockfile.
- Set the project Node requirement to 22 or newer.

### Verification

```powershell
npm.cmd ci
npm.cmd run types:bindings:check
npm.cmd test -- test/worker-dependencies.test.ts
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

The dry-run must list Queue, D1, and AI bindings. If sandbox restrictions block
Wrangler's external/profile access, record the limitation for controller
verification rather than claiming success.

---

## Task 6: Operations documentation and production handoff

**Files**

- Modify `README.md`.
- Modify `docs/operations/observability.md`.
- Modify the approved design and this plan.

### Query Builder contract

Document direct custom fields:

- `event`;
- `webhookEventId` or `operationId`;
- `stage`;
- `outcome`;
- `errorType`.

To discover a new event ID, filter:

| Field | Operator | Value |
| --- | --- | --- |
| `event` | Equals | `webhook.enqueue.completed` |
| `stage` | Equals | `webhook` |
| `outcome` | Equals | `success` |

Copy `webhookEventId`, then run a separate
`webhookEventId Equals <value>` query. Because filters combine with `AND`, do
not combine the mutually exclusive identifier fields.

### Privacy audit

Generate:

```powershell
$privacyMarker = "OBS-PRIVACY-" + [guid]::NewGuid().ToString("N")
```

Send one weather mention containing the marker, confirm processing telemetry
exists, then search the entire Worker Logs window for the marker with no
correlation filter. Require zero results. Traces are disabled and are not
reported as searched.

### Deployment gate

```powershell
npm.cmd ci
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
npx wrangler d1 migrations list line-bot-diagnostics --remote
npx wrangler d1 migrations apply line-bot-diagnostics --remote
npx wrangler d1 migrations list line-bot-diagnostics --remote
npx wrangler versions list
$knownGoodVersionId = "<VERSION_ID>"
npm.cmd run deploy
```

The checked-in migrations are `0001_questions.sql`,
`0002_group_admins.sql`, `0003_worker_metrics.sql`, and
`0004_group_settings_weather_cache.sql`. Review them before remote apply and
require compatibility with the previous Worker version.

After production smoke succeeds, run `npx wrangler versions list` again and
record the newly deployed Version ID.

Rollback uses:

```powershell
npx wrangler rollback $knownGoodVersionId --message "rollback after failed smoke"
```

Worker rollback does not revert D1 migrations/data or other resource state.

### Documentation checklist

- [ ] Logs `1.0` and Traces disabled are consistent in all four documents.
- [ ] The fetch-span privacy reason and future safe-boundary requirement appear.
- [ ] No proxy Worker is proposed for phase one.
- [ ] Event sequences match the runtime catalog and flow tests.
- [ ] Query Builder fields/operators and identifier discovery are exact.
- [ ] Unique-marker privacy audit is executable.
- [ ] Node 22+, `npm ci`, dry-run, migration gates, and Version IDs are used.
- [ ] Production smoke is explicitly pending.

---

## Task 7: Final verification and report

Run the complete fresh gate:

```powershell
npm.cmd ci
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
git diff --check
```

Run contradiction/privacy scans:

```powershell
rg -n "head_sampling_rate.?[:=].?0\.1|knownGoodDeployment|deployments list|console\.log\(JSON|string writer|sampled traces|Traces use 10%" README.md docs wrangler.jsonc test src
rg -n "question:|answer:|userId:|groupId:|replyToken:|authorization:|accessToken:|secret:|error:" src/telemetry/logger.ts
```

Expected:

- locked install exits zero;
- binding drift check exits zero;
- the full Vitest suite passes;
- TypeScript exits zero;
- dry-run exits zero and lists Queue, D1, and AI;
- `git diff --check` reports no whitespace errors;
- contradiction scan returns no stale phase-one instructions;
- telemetry scan finds no forbidden event fields;
- production smoke remains recorded as pending.

Write RED/GREEN evidence, files changed, deviations, unresolved concerns, and
the pending production-only checks to
`.superpowers/sdd/observability-final-fixes-report.md`. Do not commit; the
controller owns Git index writes.
