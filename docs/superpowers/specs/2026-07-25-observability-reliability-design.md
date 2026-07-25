# Observability and Reliability Baseline Design

## Status

Approved for specification on 2026-07-25. This document defines the first reliability-focused optimization phase for the LINE running-community bot.

## Goal

Make production failures easy to locate and explain from the Cloudflare Dashboard while preserving user privacy and keeping operations simple.

The phase succeeds when an operator can use one `webhookEventId` to determine:

- which processing stage an event reached;
- why it fell back, retried, or failed;
- whether the final LINE delivery succeeded; and
- how long the important stages took.

No log may expose message text, LINE user IDs, access tokens, channel secrets, analytics keys, or complete third-party response bodies.

## Scope

### Included

- Enable Cloudflare Workers Logs and Traces.
- Add structured, privacy-safe events across webhook, queue, answer, LINE delivery, storage, and cron paths.
- Preserve D1 metrics for longer-term operational trends.
- Generate Worker binding types from Wrangler configuration.
- Add automated verification for the logging contract and failure paths.
- Document Dashboard queries, manual inspection thresholds, deployment gates, smoke checks, and rollback.

### Excluded

- Proactive email, chat, or pager alerts.
- A third-party observability platform.
- A custom operations dashboard.
- A staging environment.
- Gradual production rollout.
- New end-user or running-community features.

These exclusions keep the first phase focused on diagnosis and safe operation. They may be reconsidered after production baselines are available.

## Observability Architecture

### Correlation

Use the existing LINE `webhookEventId` as the correlation identifier for every event-specific log and metric. It must flow through webhook acceptance, queue processing, intent selection, provider calls, LINE delivery, and persistence.

Events that do not originate from a LINE webhook, such as scheduled cleanup, use a generated operation identifier. The identifier must be created with `crypto.randomUUID()`.

### Structured event contract

Introduce one logger boundary that emits JSON objects. Every event contains:

- `event`: stable machine-queryable event name;
- `stage`: one of `webhook`, `queue`, `answer`, `line`, `storage`, or `cron`;
- `outcome`: one of `success`, `retry`, `fallback`, or `failed`;
- `webhookEventId` or `operationId`;
- `timestamp`.

Optional fields are included only when relevant:

- `intent`;
- `model`;
- `durationMs`;
- `retryDelaySeconds`;
- `errorType`;
- `detail`.

`errorType` and `detail` must use an allowlisted vocabulary. They must not contain raw exception messages from external providers because those messages may contain request data.

### Privacy rules

The logger interface must not accept the question, answer, LINE user ID, reply token, group ID, authorization headers, secrets, or arbitrary error objects.

Tests must fail if forbidden field names are added to the structured event type or serializer. The discovery-mode group ID log remains a temporary operator workflow and must be explicitly documented; normal production events do not log group IDs.

### Cloudflare configuration

Configure Workers Logs at a `1.0` head sampling rate and Traces at `0.1` for the initial baseline period.

The sampling values are explicit in `wrangler.jsonc`. After enough traffic has been observed, operators may lower them based on volume and cost without changing the structured event contract.

### D1 metrics boundary

D1 metrics remain the source for longer-term aggregates such as:

- answered and unavailable rates;
- reply and push fallback outcomes;
- intent distribution;
- model distribution;
- end-to-end duration.

Workers Logs and Traces diagnose individual executions. D1 metrics show operational trends. The implementation must not copy message content into either system.

## Event Flow

### Webhook

1. Receive request.
2. Validate the LINE signature.
3. Parse the webhook body.
4. Route admin commands or eligible mentions.
5. Enqueue each eligible message.
6. Emit a completion or classified failure event.

Signature failures and invalid JSON are logged as classifications only. The signature and request body are never logged.

### Queue consumer

1. Start processing with `webhookEventId`.
2. Claim the D1 question lease.
3. Classify intent and select the answer service.
4. Call Open-Meteo or Workers AI.
5. Prepare the answer record.
6. Attempt LINE reply.
7. Fall back to LINE push when the reply token is unusable.
8. Complete or release the D1 record.
9. Acknowledge or retry the queue message.

Each fallback or retry emits one event at the decision point. A final completion event records the end-to-end outcome and duration.

### Scheduled cleanup

1. Generate an `operationId`.
2. Start expired-record cleanup.
3. Record completion and duration.
4. On failure, emit a structured error event and rethrow so Cloudflare records the invocation as failed.

Cron failures must not be silently swallowed.

## Failure Classification

Use stable categories rather than arbitrary provider messages:

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

The implementation may add a category only when it changes an operator's next diagnostic action.

## Reliability Behavior

Existing degradation behavior remains:

- Workers AI primary failure may use the configured code-level fallback model.
- An unusable LINE reply token may fall back to LINE push.
- Temporary provider, Queue, or D1 failures use bounded retries.
- Exhausted queue retries flow to the configured dead-letter queue.

Logging must not introduce a new failure path. If an optional D1 metric write fails, the primary answer flow continues. Native `console` logging remains synchronous and does not require a separate external request.

## Binding Type Safety

Generate Worker binding declarations with `wrangler types` instead of maintaining a handwritten binding interface.

The generated declaration is checked into the repository or deterministically generated before type checking. The chosen workflow must make a binding change fail CI or the local verification gate when code and `wrangler.jsonc` disagree.

Test-only dependency overrides remain separate from production bindings.

## Deployment Safety

The required deployment sequence is:

1. Install locked dependencies.
2. Generate or verify Wrangler binding types.
3. Run the full test suite.
4. Run TypeScript type checking.
5. Run `wrangler deploy --dry-run`.
6. Apply reviewed, backward-compatible D1 migrations.
7. Deploy the Worker.
8. Run production health, LINE mention, D1, Queue, and Dashboard smoke checks.
9. Record the deployment ID.

If production checks fail, roll back to the recorded known-good deployment. Worker rollback does not revert D1 migrations or other resource state, so migrations must remain backward compatible with the previous Worker version.

Staging and gradual deployment are deferred until the operational baseline shows that their additional resources and configuration are justified.

## Dashboard Runbook

The manual inspection routine covers:

### Worker

- invocation outcomes;
- uncaught exceptions;
- CPU and wall time;
- HTTP 5xx responses.

### Logs and Traces

- search by `webhookEventId`;
- verify the ordered stage sequence;
- identify fallback or retry decisions;
- inspect the final outcome and duration.

### Queue

- backlog count;
- oldest message age;
- consumer results;
- retry and dead-letter outcomes.

### D1 metrics

- answer success rate;
- provider-unavailable rate;
- reply and push failure rate;
- fallback frequency;
- duration grouped by intent and model.

## Initial Manual Thresholds

The first phase uses operator judgment rather than automatic alerts:

- Investigate when queue backlog keeps growing or the oldest message exceeds two minutes.
- Investigate repeated `provider_unavailable` or `reply_failed` outcomes in a short period.
- Investigate when fallback frequency is visibly above the normal daily baseline.
- Confirm one successful cleanup execution per day.
- Treat any message content, LINE user ID, group ID, token, or secret in normal logs as a privacy incident.

These are runbook triggers, not automated service-level objectives. Numeric alert thresholds are deferred until real baseline data exists.

## Testing

### Unit tests

- Validate the structured event schema.
- Validate event serialization.
- Reject forbidden fields.
- Verify stable failure classifications.
- Verify duration and identifier handling.

### Flow tests

- Workers AI primary-to-fallback sequence.
- LINE reply-to-push sequence.
- D1 claim, prepare, complete, and release failures.
- Queue retry classification.
- Weather provider failure.
- Cron success and failure.
- Final success, retry, and failed event sequences.

Tests assert classifications and stage order without asserting raw user content.

### Deployment verification

- Full Vitest suite.
- TypeScript type checking.
- Wrangler binding type generation or verification.
- Wrangler deployment dry-run.
- Production smoke checks documented in the runbook.

## Acceptance Criteria

- Workers Logs and Traces are enabled with explicit sampling.
- All critical webhook, queue, answer, LINE, storage, and cron transitions emit structured events.
- A single `webhookEventId` reconstructs a processing path in the Dashboard.
- Logs contain no forbidden user content or credentials.
- D1 metrics continue to provide aggregate trends.
- Wrangler-generated binding types prevent configuration drift.
- Failure paths have automated event-sequence coverage.
- The deployment and rollback runbook is executable by an operator using the repository documentation.
- Existing tests, type checking, and deployment dry-run pass.

## Deferred Follow-up

After baseline data is available, review:

- lower sampling rates based on event volume and cost;
- proactive alerts derived from observed failure rates;
- staging resources;
- gradual deployments and version-specific smoke tests;
- export to an external OpenTelemetry destination;
- explicit service-level objectives.
