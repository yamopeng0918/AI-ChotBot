# Observability operations

## Privacy contract

Normal logs may contain event names, stage, outcome, `webhookEventId`, intent,
model, duration, retry delay, and allowlisted classifications. They must not
contain message or answer text, LINE user/group IDs, reply tokens, credentials,
authorization headers, or raw provider errors.

The temporary `LINE_GROUP_ID=__DISCOVER__` workflow is the sole exception: it
prints the source group ID for setup and must be disabled immediately afterward.

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

This check is production-only and remains pending until a real deployment.

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
