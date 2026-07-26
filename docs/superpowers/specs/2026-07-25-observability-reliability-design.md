# Observability and Reliability Baseline Design

## Status

Approved for specification on 2026-07-25 and amended on 2026-07-26 after the
final privacy and operability review. This document defines the first
reliability-focused optimization phase for the LINE running-community bot.

The amendment keeps Workers Logs at full sampling and explicitly defers
Cloudflare Traces. It also makes structured field indexing, correlation,
transition semantics, deployment gates, and Version-ID rollback normative.

## Goal

Make production failures easy to locate and explain from the Cloudflare
Dashboard while preserving user privacy and keeping operations simple.

The phase succeeds when an operator can use one correlation identifier to
determine:

- which processing stage an event reached;
- why it fell back, retried, deduplicated, or failed;
- whether final LINE delivery succeeded;
- whether required storage transitions completed; and
- how long provider, terminal question, and scheduled cleanup work took.

A parsed LINE event uses its `webhookEventId`. A request rejected before a
trusted LINE event identifier is available, and a scheduled cleanup operation,
uses an `operationId`.

No normal log may expose message or answer text, LINE user or group IDs, reply
tokens, access tokens, channel secrets, analytics keys, authorization headers,
arbitrary error objects, or complete provider responses.

## Scope

### Included

- Enable Cloudflare Workers Logs at a `1.0` head sampling rate.
- Explicitly disable Cloudflare Traces for phase one.
- Add structured, privacy-safe events across webhook, synchronous admin,
  queue, answer, LINE delivery, storage, and cron paths.
- Preserve D1 metrics for longer-term operational trends.
- Generate Worker binding types from Wrangler configuration.
- Add automated verification for field indexing, correlation, privacy,
  transitions, durations, and final event sequences.
- Document exact Query Builder filters, manual inspection thresholds, privacy
  auditing, deployment gates, migration handling, smoke checks, Version ID
  recording, and rollback.

### Excluded

- A proxy Worker or another trace workaround in phase one.
- Cloudflare Traces until a privacy-safe external-request boundary exists.
- Proactive email, chat, or pager alerts.
- A third-party observability platform.
- A custom operations dashboard.
- A staging environment.
- Gradual production rollout.
- New end-user or running-community features.

These exclusions keep the phase focused on safe diagnosis and operation. They
may be reconsidered after production baselines and a trace-specific privacy
design are available.

## Observability architecture

### Correlation invariant

Every telemetry event contains exactly one correlation field:

```ts
type TelemetryCorrelation =
  | { webhookEventId: string; operationId?: never }
  | { operationId: string; webhookEventId?: never };
```

The identifier rules are:

- parsed LINE events use the existing `webhookEventId`;
- `webhook.enqueue.failed` retains the current job's `webhookEventId`;
- missing/invalid signatures and invalid JSON use a request `operationId`;
- synchronous admin events use the LINE event ID when present and otherwise a
  generated operation identifier;
- scheduled cleanup uses one `crypto.randomUUID()` operation identifier for its
  start and terminal events.

No event may omit both identifiers or carry both.

### Canonical event contract

One telemetry module owns the canonical event-name catalog, stages, outcomes,
error classifications, detail vocabulary, correlation union, allowlisted
projection, and console sink. `event` is a closed union derived from the
catalog, not an arbitrary string.

Every event contains:

- `event`;
- `stage`: `webhook`, `queue`, `answer`, `line`, `storage`, or `cron`;
- `outcome`: `success`, `retry`, `fallback`, or `failed`;
- exactly one correlation identifier;
- `timestamp`.

Optional fields appear only when relevant:

- `intent`;
- `model`;
- `durationMs`;
- `retryDelaySeconds`;
- `errorType`;
- `detail`.

The canonical event names are:

- `webhook.rejected`;
- `webhook.enqueue.completed`;
- `webhook.enqueue.failed`;
- `admin.reply.completed`;
- `admin.reply.failed`;
- `question.started`;
- `question.deduplicated`;
- `question.retry`;
- `question.completed`;
- `storage.claim.completed`;
- `storage.claim.failed`;
- `storage.prepare.completed`;
- `storage.prepare.failed`;
- `storage.complete.completed`;
- `storage.complete.failed`;
- `storage.release.failed`;
- `answer.ai.attempt.started`;
- `answer.ai.attempt.completed`;
- `answer.ai.attempt.failed`;
- `answer.ai.fallback.started`;
- `answer.prepared.reused`;
- `answer.completed`;
- `answer.failed`;
- `weather.settings.failed`;
- `line.reply.completed`;
- `line.reply.failed`;
- `line.push.completed`;
- `line.push.failed`;
- `queue.message.retry`;
- `cron.cleanup.started`;
- `cron.cleanup.completed`;
- `cron.cleanup.failed`.

### Structured production sink

The logger constructs a new plain object from an explicit allowlist and passes
that object directly to `console.log`. It does not stringify the record first.
This allows Workers Logs to extract and index custom fields such as `event`,
`webhookEventId`, `stage`, and `errorType`.

The injected writer used by tests has the same object contract as production:

```ts
write: (record: TelemetryRecord) => void
```

Projection failures and writer failures are swallowed at the telemetry
boundary. Observability must never change request, queue, LINE, storage, or
cron behavior.

### Privacy rules

The telemetry type and serializer do not accept:

- `question`;
- `answer`;
- `userId`;
- `groupId`;
- `replyToken`;
- `authorization`;
- `accessToken`;
- `secret`;
- `error`.

A compile-time assertion fails if any forbidden key is added to the event
union. Runtime tests also add forbidden properties after type checking and
verify that the allowlisted projection omits them.

`errorType` and `detail` use closed vocabularies. Raw caught errors and provider
messages never cross the logger boundary.

The `LINE_GROUP_ID=__DISCOVER__` setup workflow remains the sole temporary
group-ID exception and is not a structured telemetry event. Operators must
disable it immediately after discovery.

## Cloudflare configuration and trace privacy

`wrangler.jsonc` explicitly configures:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "head_sampling_rate": 1 },
  "traces": { "enabled": false }
}
```

Traces are disabled because Cloudflare automatically instruments external
`fetch` calls and may record `url.full` and `url.query`. Open-Meteo receives a
user-derived city in its URL query. Sampling traces at any non-zero rate would
therefore violate the normal-log privacy boundary.

Trace enablement is a future design decision. It requires a reviewed
external-request boundary that prevents user-derived values from appearing in
trace-visible URL attributes, plus a production privacy smoke. A proxy Worker
is explicitly outside this phase.

The configuration test must parse JSONC with Wrangler's comment-tolerant
configuration reader and assert the complete observability object. It must not
use a parser that rejects valid JSONC comments.

## D1 metrics boundary

D1 metrics remain the source for longer-term aggregates:

- answered and unavailable rates;
- reply and push fallback outcomes;
- intent distribution;
- model distribution;
- end-to-end duration.

Workers Logs diagnose individual executions. D1 metrics show trends. Neither
system receives message content through the telemetry implementation.

## Event flows

### Webhook and synchronous admin

1. Generate a request `operationId`.
2. Read and verify the LINE signature without logging it or the request body.
3. On missing/invalid signature or invalid JSON, emit `webhook.rejected` with
   the operation identifier and a stable classification.
4. For each parsed LINE event, use its `webhookEventId` when present.
5. Route admin commands synchronously. Emit `admin.reply.completed` or
   `admin.reply.failed`.
6. Enqueue each eligible mention. Emit `webhook.enqueue.completed` or
   `webhook.enqueue.failed` with the job's event identifier.

### Generic queue success

```text
question.started
storage.claim.completed
answer.completed
storage.prepare.completed
line.reply.completed
storage.complete.completed
question.completed
```

The webhook invocation's preceding `webhook.enqueue.completed` event shares the
same identifier.

### Workers AI primary and fallback

A primary success emits:

```text
answer.ai.attempt.started
answer.ai.attempt.completed
answer.completed
```

An AI fallback success emits:

```text
answer.ai.attempt.started        primary
answer.ai.attempt.failed         primary
answer.ai.fallback.started
answer.ai.attempt.started        fallback
answer.ai.attempt.completed      fallback
answer.completed
```

Attempt terminal events and `answer.completed` include stage duration. Model
role is represented by `primary_model` or `fallback_model`; raw provider errors
are not logged.

### Weather

Weather provider timeouts and provider failures remain distinct from D1
settings/cache failures:

- provider timeout: `weather_timeout`;
- provider failure: `weather_provider_error`;
- group settings failure: `weather.settings.failed`,
  `storage_unavailable`, `weather_settings`;
- cache read/write failure: `weather.cache.failed`,
  `storage_unavailable`, with `weather_cache_read` or
  `weather_cache_write`.

The weather cache is optional. A cache-read failure emits the safe storage
event and continues to Open-Meteo. A cache-write failure after a valid provider
response emits the safe storage event and returns that valid answer. Neither
cache failure becomes `provider_unavailable` or a retry.

### Prepared and duplicate claims

Prepared-answer reuse emits:

```text
question.started
storage.claim.completed
answer.prepared.reused
line.reply.completed
storage.complete.completed
question.completed
```

A completed duplicate emits:

```text
question.started
storage.claim.completed
question.deduplicated
```

It does not claim a new successful completion whose stored outcome is unknown.

### Storage

Successful claim, prepare, and complete transitions emit stable success events.
Mandatory claim, prepare, complete, group-settings, and release failures emit
classified storage events without raw errors. Optional weather-cache failures
emit `weather.cache.failed` and do not change the answer or disposition.

A retry disposition always terminates with `question.retry` and includes
`retryDelaySeconds`. A best-effort `storage.release.failed` event does not
replace that terminal retry.

### LINE delivery

Reply success proceeds to storage completion and `question.completed`.

An unusable reply token emits `line.reply.failed` with a fallback outcome,
then attempts push. Push success emits `line.push.completed` before storage and
question completion.

If reply and push both fail, the terminal sequence includes:

```text
line.reply.failed
line.push.failed
storage.complete.completed | storage.complete.failed
question.retry
```

The retry contains a delay even if recording the `reply_failed` terminal status
also fails.

### Scheduled cleanup

1. Generate one `operationId` with `crypto.randomUUID()`.
2. Emit `cron.cleanup.started`.
3. Purge expired records.
4. Emit `cron.cleanup.completed` with `durationMs`, or emit
   `cron.cleanup.failed` with `durationMs` and `cron_cleanup_failed`.
5. Rethrow a stable error after failure telemetry so Cloudflare records the
   invocation as failed.

## Failure classifications

Stable classifications are:

- `invalid_signature`;
- `invalid_json`;
- `queue_unavailable`;
- `lease_unavailable`;
- `storage_unavailable`;
- `ai_rate_limited`;
- `ai_timeout`;
- `ai_provider_error`;
- `weather_timeout`;
- `weather_provider_error`;
- `line_reply_failed`;
- `line_push_failed`;
- `cron_cleanup_failed`;
- `unexpected_error`.

A new category is justified only when it changes an operator's next diagnostic
action.

## Reliability behavior

Existing degradation behavior remains:

- Workers AI primary failure may use the configured fallback model.
- An unusable LINE reply token may fall back to LINE push.
- Temporary provider, Queue, or mandatory D1 persistence/settings failures use
  bounded retries.
- Exhausted Queue retries flow to the configured dead-letter queue.
- Optional weather-cache and D1 metric failures do not fail the primary answer
  flow.
- Telemetry projection or writer failure never changes processing.

Every `ProcessResult` retry path has an explicit terminal telemetry event with
the same delay passed to the queue retry operation.

## Binding and package type safety

Wrangler generates `worker-configuration.d.ts` from `wrangler.jsonc`. The
checked-in declaration is verified before TypeScript checking, so a binding
change fails the local/CI gate when configuration and code drift.

Test-only `FETCHER` composition remains separate from production bindings.
Generated runtime declarations make a direct
`@cloudflare/workers-types` development dependency unnecessary. The package
and lockfile are updated through npm.

The repository requires Node.js 22 or newer because the pinned Wrangler version
requires it.

## Deployment safety

The required production sequence is:

1. Install locked dependencies with `npm ci`.
2. Verify Wrangler binding types.
3. Run the full test suite.
4. Run TypeScript type checking.
5. Run `wrangler deploy --dry-run`.
6. Review every pending D1 migration and confirm backward compatibility with
   the currently deployed Worker.
7. List and apply remote pending D1 migrations.
8. Record the current known-good Worker Version ID.
9. Deploy the Worker.
10. Run production health, LINE, D1, Queue, Dashboard, and privacy smoke checks.
11. List and record the newly deployed Worker Version ID.

The checked-in migrations are `0001_questions.sql`,
`0002_group_admins.sql`, `0003_worker_metrics.sql`, and
`0004_group_settings_weather_cache.sql`.

Rollback takes a Worker Version ID. It does not revert D1 migrations, D1 data,
or other external resource state, so schema changes must remain compatible with
the previous Worker version. Database restoration is a separate reviewed
operation.

Production smoke remains pending until a real deployment. Local fake endpoints
cannot satisfy it.

## Dashboard runbook

The operations runbook defines exact Query Builder filters for:

- `event`;
- `webhookEventId` or `operationId`;
- `stage`;
- `outcome`;
- `errorType`.

Operators discover a new `webhookEventId` by filtering for the structured
`webhook.enqueue.completed` event in a narrow time window, then run a separate
identifier query. Multiple Query Builder filters use `AND`, so the two
mutually exclusive identifier fields are never combined.

The privacy audit sends a unique harmless weather marker, confirms the
processing event exists, and requires zero marker occurrences in Logs over the
full time window. Traces are disabled and are not reported as searched.

## Testing

### Logger and type tests

- Object emission to the injected writer.
- Independently indexed allowlisted fields.
- Runtime-added forbidden property omission.
- Throwing projection/writer isolation.
- Compile-time forbidden-key rejection.
- Required and mutually exclusive correlation identifiers.
- Canonical event-name vocabulary.

### Webhook and boundary tests

- Pre-auth/pre-parse `operationId`.
- Enqueue failure job correlation.
- Admin reply success/failure correlation.
- Unexpected queue retry.
- Cron success/failure with shared operation identifier and terminal duration.

### Flow tests

- Generic success in exact order.
- Workers AI primary success.
- Workers AI primary-to-fallback success and safe reason.
- Weather success, timeout, provider failure, settings/cache storage failure.
- Claim, prepare, complete, and release successes/failures.
- Prepared-answer reuse.
- Completed duplicate.
- Reply-to-push success.
- Reply-plus-push failure ending in retry with delay.
- Final success, fallback, retry, and failure sequences.

Tests assert classifications, stage order, identifiers, and durations without
asserting or emitting raw user content.

### Deployment verification

- Locked install.
- Full Vitest suite.
- TypeScript type checking.
- Wrangler binding drift check.
- Wrangler deployment dry-run.
- Documentation contradiction/privacy scans.
- Production smoke recorded as pending until deployment.

## Acceptance criteria

- Workers Logs are enabled at `1.0`; Traces are explicitly disabled.
- The trace privacy reason and future safe-boundary prerequisite are documented.
- Every telemetry event has exactly one correlation identifier.
- Production emits allowlisted plain objects, so custom fields are indexed.
- Critical webhook, admin, queue, answer, LINE, storage, and cron transitions
  emit canonical events.
- A single identifier reconstructs the applicable processing path in Query
  Builder.
- Every retry disposition ends with a retry event containing its delay.
- Provider and cron terminals include durations.
- Logs contain no forbidden content, credentials, or raw errors.
- D1 metrics continue to provide aggregate trends.
- Wrangler-generated bindings prevent configuration drift.
- Failure paths have exact ordered sequence coverage.
- Deployment, migration, version recording, and rollback instructions are
  executable and use Worker Version IDs.
- Automated gates pass; production smoke remains pending until real deployment.

## Deferred follow-up

After baseline data is available, review:

- a privacy-safe external-request boundary and trace-specific threat model;
- trace enablement only after production privacy validation;
- lower Logs sampling based on measured volume and cost;
- proactive alerts derived from observed failure rates;
- staging resources;
- gradual deployments and version-specific smoke tests;
- export to an external OpenTelemetry destination;
- explicit service-level objectives.
