# Observability operations

This runbook covers the production Cloudflare Worker
`line-running-community-bot`. Production-only smoke checks remain pending until
a real deployment is performed with production credentials.

## Phase-one telemetry policy

Workers Logs are enabled at a `1.0` head sampling rate, so every invocation in
the baseline period is eligible for collection. Cloudflare Traces are
explicitly disabled for phase one.

Traces remain disabled because Cloudflare's automatic `fetch` spans may include
`url.full` and `url.query`. The Open-Meteo request URL can contain a
user-derived city, so enabling those spans would violate the privacy contract.
Future trace enablement requires a reviewed, privacy-safe external-request
boundary that keeps user-derived values out of trace-visible URL attributes.
Adding a proxy Worker is not part of phase one.

## Privacy contract

Normal structured logs may contain:

- `event`;
- `stage`;
- `outcome`;
- exactly one of `webhookEventId` or `operationId`;
- `timestamp`;
- `intent`;
- `model`;
- `durationMs`;
- `retryDelaySeconds`;
- allowlisted `errorType` and `detail` values.

They must not contain message or answer text, LINE user or group IDs, reply
tokens, credentials, authorization headers, access tokens, secrets, arbitrary
error objects, or raw provider errors.

The temporary `LINE_GROUP_ID=__DISCOVER__` workflow is the sole exception. It
prints the source group ID for setup and must be disabled immediately after the
ID is obtained. No normal telemetry event may carry that group ID.

## Structured event fields

The production logger passes an allowlisted plain object to `console.log`.
Cloudflare therefore indexes each custom property as a Query Builder field.

| Field | Use |
| --- | --- |
| `event` | Stable event name from the runtime catalog |
| `webhookEventId` | Correlates a parsed LINE event through webhook and queue processing |
| `operationId` | Correlates pre-parse rejection or scheduled cleanup |
| `stage` | `webhook`, `queue`, `answer`, `line`, `storage`, or `cron` |
| `outcome` | `success`, `retry`, `fallback`, or `failed` |
| `errorType` | Safe failure classification |
| `detail` | Safe decision detail such as `primary_model` or `weather_cache_read` |
| `durationMs` | Provider, terminal question, deduplication, or cron duration |
| `retryDelaySeconds` | Delay selected for a retry disposition |

## Find a webhook correlation ID

1. Open Cloudflare Dashboard > Workers & Pages >
   `line-running-community-bot` > Observability.
2. Select a narrow time range around the LINE event.
3. In Query Builder, add these filters:

   | Field | Operator | Value |
   | --- | --- | --- |
   | `event` | Equals | `webhook.enqueue.completed` |
   | `stage` | Equals | `webhook` |
   | `outcome` | Equals | `success` |

4. Open the matching event in the Events view and copy its
   `webhookEventId`.
5. Start a separate query with one filter:

   | Field | Operator | Value |
   | --- | --- | --- |
   | `webhookEventId` | Equals | the copied value |

6. Order the Events view by timestamp ascending and compare the result with
   the event sequences below.

Query Builder combines multiple filters with `AND`. Do not add both
`webhookEventId` and `operationId`; every telemetry event intentionally has
exactly one correlation field.

If several mentions arrive in the same window, send one controlled smoke event
during a quiet interval and use its enqueue timestamp to select the correct
structured event.

## Find an operation correlation ID

Webhook requests rejected before a trusted LINE event ID is available use an
`operationId`.

For a rejected request, filter:

| Field | Operator | Value |
| --- | --- | --- |
| `event` | Equals | `webhook.rejected` |
| `stage` | Equals | `webhook` |
| `outcome` | Equals | `failed` |
| `errorType` | Equals | `invalid_signature` or `invalid_json` |

Copy `operationId`, then run a separate
`operationId Equals <copied value>` query.

Scheduled cleanup also uses an `operationId`. Filter
`event Equals cron.cleanup.started`, copy the identifier, and query that
identifier to see the matching terminal event.

## Failure and fallback filters

Use the following exact fields:

- `outcome Equals failed` and `errorType Exists` for classified failures;
- `outcome Equals retry` for retry decisions;
- `outcome Equals fallback` for provider or LINE fallback decisions;
- `stage Equals answer`, `line`, or `storage` to narrow an investigation;
- `errorType Equals <classification>` when the classification is already
  known.

Useful exact classifications include `lease_unavailable`,
`storage_unavailable`, `ai_rate_limited`, `ai_timeout`,
`ai_provider_error`, `weather_timeout`, `weather_provider_error`,
`line_reply_failed`, `line_push_failed`, `queue_unavailable`,
`cron_cleanup_failed`, and `unexpected_error`.

## Expected event sequences

`webhook.enqueue.completed` is emitted by the webhook invocation. The
remaining question events are emitted by the queue invocation and share the
same `webhookEventId`.

### Generic injected answer-service success

```text
webhook.enqueue.completed
question.started
storage.claim.completed
answer.completed
storage.prepare.completed
line.reply.completed
storage.complete.completed
question.completed
```

### Production Workers AI primary success

```text
webhook.enqueue.completed
question.started
storage.claim.completed
answer.ai.attempt.started        detail=primary_model
answer.ai.attempt.completed      detail=primary_model, durationMs present
answer.completed                 durationMs present
storage.prepare.completed
line.reply.completed
storage.complete.completed
question.completed               durationMs present
```

### Production Workers AI fallback success

```text
webhook.enqueue.completed
question.started
storage.claim.completed
answer.ai.attempt.started        detail=primary_model
answer.ai.attempt.failed         detail=primary_model, errorType and durationMs present
answer.ai.fallback.started       outcome=fallback, detail=fallback_model
answer.ai.attempt.started        detail=fallback_model
answer.ai.attempt.completed      detail=fallback_model, durationMs present
answer.completed                 durationMs present
storage.prepare.completed
line.reply.completed
storage.complete.completed
question.completed               durationMs present
```

### Prepared-answer reuse

```text
question.started
storage.claim.completed
answer.prepared.reused           detail=reused_prepared
line.reply.completed
storage.complete.completed
question.completed               durationMs present
```

No new `answer.completed` or `storage.prepare.completed` event is expected for
prepared reuse.

### Completed duplicate

```text
question.started
storage.claim.completed
question.deduplicated            durationMs present
```

A completed duplicate is acknowledged without a new
`question.completed` event because its stored terminal outcome is not
reclassified.

### LINE reply fallback to push

```text
line.reply.failed                outcome=fallback, errorType=line_reply_failed
line.push.completed
storage.complete.completed
question.completed
```

### LINE reply and push both fail

```text
line.reply.failed                outcome=fallback, errorType=line_reply_failed
line.push.failed                 outcome=failed, errorType=line_push_failed
storage.complete.completed       or storage.complete.failed
question.retry                   retryDelaySeconds present
```

The final `question.retry` is required even if recording the `reply_failed`
terminal status also fails.

### Storage retry branches

- Claim exception:
  `storage.claim.failed` followed by `question.retry`.
- Busy lease:
  `storage.claim.completed` followed by `question.retry`.
- Prepare exception:
  `storage.prepare.failed`, optional `storage.release.failed`, then
  `question.retry`.
- Complete exception:
  `storage.complete.failed` followed by `question.retry`.
- Release failure:
  `storage.release.failed` is emitted without replacing the terminal retry
  decision.

Every retry terminal contains `retryDelaySeconds`.

### Weather branches

- A successful provider call emits `answer.completed` with
  `intent=weather`, its model, and `durationMs`.
- Provider timeout or failure emits `answer.failed` with
  `weather_timeout` or `weather_provider_error`.
- Group-settings failure emits `weather.settings.failed` with
  `errorType=storage_unavailable` and `detail=weather_settings`, then
  `question.retry`.
- Weather cache read/write failures emit `weather.cache.failed`, classified as
  `storage_unavailable` with `detail=weather_cache_read` or
  `weather_cache_write`; they must not be classified as provider errors.
  A read failure continues to Open-Meteo, and a write failure preserves the
  valid provider answer. The correlated flow still ends in
  `answer.completed` and `question.completed`, with no `question.retry`.

### Admin commands

A synchronous admin command emits either `admin.reply.completed` or
`admin.reply.failed`. Parsed LINE events use `webhookEventId`; an admin command
without one uses a generated `operationId`. The failure uses
`errorType=line_reply_failed`.

### Scheduled cleanup

```text
cron.cleanup.started
cron.cleanup.completed           durationMs present
```

or:

```text
cron.cleanup.started
cron.cleanup.failed              errorType=cron_cleanup_failed, durationMs present
```

Both events share one `crypto.randomUUID()` operation identifier. A cleanup
failure is rethrown after the safe event is emitted so Cloudflare also records
the invocation as failed.

## D1 metrics queries

These queries read only safe operational fields from the `metrics` table. They
cover the most recent seven days; change `-7 days` only when a longer review
window is required.

Daily counts and rates by status:

```powershell
npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT date(created_at) AS day, status, COUNT(*) AS event_count, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY date(created_at)), 2) AS rate_percent FROM metrics WHERE created_at >= datetime('now', '-7 days') GROUP BY date(created_at), status ORDER BY day DESC, status;"
```

Daily counts and rates by intent:

```powershell
npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT date(created_at) AS day, intent, COUNT(*) AS event_count, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY date(created_at)), 2) AS rate_percent FROM metrics WHERE created_at >= datetime('now', '-7 days') GROUP BY date(created_at), intent ORDER BY day DESC, intent;"
```

Daily counts and rates by model:

```powershell
npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT date(created_at) AS day, COALESCE(model, '(none)') AS model, COUNT(*) AS event_count, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY date(created_at)), 2) AS rate_percent FROM metrics WHERE created_at >= datetime('now', '-7 days') GROUP BY date(created_at), COALESCE(model, '(none)') ORDER BY day DESC, model;"
```

Daily average and maximum duration by intent and model:

```powershell
npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT date(created_at) AS day, intent, COALESCE(model, '(none)') AS model, COUNT(*) AS event_count, ROUND(AVG(duration_ms), 1) AS avg_duration_ms, MAX(duration_ms) AS max_duration_ms FROM metrics WHERE created_at >= datetime('now', '-7 days') GROUP BY date(created_at), intent, COALESCE(model, '(none)') ORDER BY day DESC, intent, model;"
```

## Privacy audit

Run this only against a real deployment. It remains pending until then.

1. Generate a unique harmless marker:

   ```powershell
   $privacyMarker = "OBS-PRIVACY-" + [guid]::NewGuid().ToString("N")
   $privacyMarker
   ```

2. During a quiet interval, send one LINE-native weather mention containing
   that marker, for example `@bot 查詢 <marker> 天氣`. This exercises the path
   whose external URL would make tracing unsafe.
3. Confirm a corresponding `webhook.enqueue.completed` event and queue
   processing sequence exist.
4. In Query Builder, select a time window covering the entire invocation and
   paste the exact marker into the Search field. Do not add a correlation
   filter; search all Logs for the Worker during that window.
5. Require zero matching log events.

The zero-result check is meaningful because Logs use `1.0` sampling. Traces are
disabled; do not report a trace privacy search as passed.

## Manual investigation triggers

- Backlog grows continuously or oldest message age exceeds two minutes.
- `provider_unavailable` or `reply_failed` repeats in a short period.
- AI fallback frequency is visibly above the established daily baseline.
- `question.retry` or `queue.message.retry` repeats for one event.
- The daily `cron.cleanup.completed` event is absent.
- A forbidden privacy field or marker appears in any normal log.

## Deployment

Run from the repository root with Node.js 22 or newer. The required order is
locked install, binding check, tests, typecheck, dry-run, reviewed
backward-compatible migrations, deploy, production smoke, and Version ID
recording.

```powershell
npm.cmd ci
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

Review the checked-in migration files before changing production:

```text
migrations/0001_questions.sql
migrations/0002_group_admins.sql
migrations/0003_worker_metrics.sql
migrations/0004_group_settings_weather_cache.sql
```

The previous Worker version must remain compatible with the post-migration
schema. Then list, apply, and re-list remote pending migrations:

```powershell
npx wrangler d1 migrations list line-bot-diagnostics --remote
npx wrangler d1 migrations apply line-bot-diagnostics --remote
npx wrangler d1 migrations list line-bot-diagnostics --remote
```

`migrations apply` applies every pending migration in filename order. It does
not select one file. `0001` and `0002` use bare `CREATE` statements, so do not
apply them to a database whose equivalent objects were created outside
Wrangler migration bookkeeping without first reconciling that state.

Before deploy, record the currently known-good Worker Version ID:

```powershell
npx wrangler versions list
$knownGoodVersionId = "<VERSION_ID>"
```

Replace the placeholder with the actual stable Version ID, then deploy:

```powershell
npm.cmd run deploy
```

Run the production smoke check below. If it passes, list versions again and
record the newly deployed Version ID in the deployment record:

```powershell
npx wrangler versions list
```

## Production smoke check

This check is production-only and remains pending until a real deployment.

1. Require `/health` HTTP 200 with `{"status":"ok"}`.
2. Send one harmless LINE-native mention in the allowed group.
3. Require exactly one visible answer.
4. Find its `webhookEventId` through the structured
   `webhook.enqueue.completed` event.
5. Query that identifier and require the complete applicable success sequence.
6. Confirm one `answered` D1 row using only operational fields.
7. Confirm Queue backlog returns to its prior level.
8. Run the unique-marker privacy audit.
9. Run `npx wrangler versions list` and record the deployed Version ID only
   after all checks pass.

## Rollback

Rollback accepts a Worker Version ID, not a deployment ID. Always pass the
recorded identifier; omitting it merely selects the previous uploaded version,
which may not be the known-good version.

```powershell
npx wrangler versions list
$knownGoodVersionId = "<VERSION_ID>"
npx wrangler rollback $knownGoodVersionId --message "rollback after failed smoke"
```

After rollback:

1. Repeat the health, LINE mention, D1, Queue, Dashboard, and privacy checks.
2. Record the Version ID activated by the rollback.
3. Remember that Worker rollback does not revert D1 migrations, D1 data, or
   other external resource state.
4. If schema recovery is required, use a separately reviewed D1 backup or Time
   Travel procedure. Do not treat Worker rollback as database rollback.
