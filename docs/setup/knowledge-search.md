# Knowledge-search operations runbook

This runbook covers provisioning, smoke checks, reindex/delete validation, DLQ handling, rollback, and monitoring for the knowledge-search worker.

## Prerequisites

- `npx.cmd wrangler login`
- A Cloudflare API token with `Queues Read` and `Queues Write` for DLQ pull/push operations.
- The worker deployment host name from Wrangler.
- The queue names from `wrangler.jsonc`:
  - `line-question-jobs`
  - `line-question-jobs-dlq`
  - `knowledge-ingestion-jobs`
  - `knowledge-ingestion-dlq`

## Provision resources

```powershell
npx.cmd wrangler d1 create line-bot-diagnostics
npx.cmd wrangler queues create line-question-jobs
npx.cmd wrangler queues create line-question-jobs-dlq
npx.cmd wrangler queues create knowledge-ingestion-jobs
npx.cmd wrangler queues create knowledge-ingestion-dlq
```

Copy the D1 database ID into `wrangler.jsonc`.

Apply the migration locally and remotely:

```powershell
npx.cmd wrangler d1 migrations apply line-bot-diagnostics --local
npx.cmd wrangler d1 migrations apply line-bot-diagnostics --remote
```

Set runtime secrets:

```powershell
npx.cmd wrangler secret put LINE_CHANNEL_SECRET
npx.cmd wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx.cmd wrangler secret put LINE_GROUP_ID
npx.cmd wrangler secret put OPENROUTER_API_KEY
npx.cmd wrangler secret put OPENROUTER_MODEL
npx.cmd wrangler secret put ANALYTICS_HASH_KEY
npx.cmd wrangler secret put ADMIN_API_TOKEN
```

## Smoke the worker

Run the local verification gates before any deploy:

```powershell
npm run test:e2e:knowledge
npm run test:quality:knowledge
npm run deploy -- --dry-run
```

For staging, deploy the current commit after the dry-run succeeds:

```powershell
npx.cmd wrangler d1 migrations apply line-bot-diagnostics --remote
npm run deploy
```

Then validate the health endpoint and a harmless LINE mention through the configured staging group:

```powershell
curl.exe https://<worker-host>/health
```

Inspect only operational data in D1 after the smoke:

```powershell
npx.cmd wrangler d1 execute line-bot-diagnostics --remote --command "SELECT webhook_event_id,status,model,created_at,expires_at FROM questions ORDER BY created_at DESC LIMIT 5"
```

## Reindex smoke

Use the admin API to reindex one known document, then drain the ingestion queue:

```powershell
curl.exe -X POST "https://<worker-host>/admin/knowledge/documents/<document-id>/reindex" -H "Authorization: Bearer <admin-token>"
npx.cmd wrangler queues info knowledge-ingestion-jobs
```

If you need to confirm the document still serves the prior version until publish, query the D1 rows or run the e2e test:

```powershell
npm run test:e2e:knowledge
```

## Delete smoke

Use the admin API to delete the same document, then verify the tombstone path and cleanup queue:

```powershell
curl.exe -X DELETE "https://<worker-host>/admin/knowledge/documents/<document-id>" -H "Authorization: Bearer <admin-token>"
npx.cmd wrangler queues info knowledge-ingestion-jobs
```

## DLQ inspection and replay

First inspect the queue depth and consumer state:

```powershell
npx.cmd wrangler queues info line-question-jobs-dlq
npx.cmd wrangler queues info knowledge-ingestion-dlq
```

To inspect message payloads, pull a bounded batch with the Cloudflare API:

```powershell
$headers = @{ Authorization = "Bearer $env:CF_API_TOKEN"; "Content-Type" = "application/json" }
Invoke-RestMethod -Method Post `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT_ID/queues/<DLQ_QUEUE_ID>/messages/pull" `
  -Headers $headers `
  -Body '{ "batch_size": 10, "visibility_timeout_ms": 60000 }'
```

Replay the pulled message bodies into the live queue, then acknowledge the DLQ lease IDs:

```powershell
$pulled = Invoke-RestMethod -Method Post `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT_ID/queues/<DLQ_QUEUE_ID>/messages/pull" `
  -Headers $headers `
  -Body '{ "batch_size": 10, "visibility_timeout_ms": 60000 }'

foreach ($message in @($pulled.result.messages)) {
  Invoke-RestMethod -Method Post `
    -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT_ID/queues/<LIVE_QUEUE_ID>/messages" `
    -Headers $headers `
    -Body (@{ body = ($message.body | ConvertFrom-Json) } | ConvertTo-Json -Compress)
}

$acks = @($pulled.result.messages | ForEach-Object { @{ lease_id = $_.lease_id } })
Invoke-RestMethod -Method Post `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT_ID/queues/<DLQ_QUEUE_ID>/messages/ack" `
  -Headers $headers `
  -Body (@{ acks = $acks } | ConvertTo-Json -Compress)
```

After replay is confirmed, purge any leftover DLQ messages:

```powershell
npx.cmd wrangler queues purge line-question-jobs-dlq
npx.cmd wrangler queues purge knowledge-ingestion-dlq
```

## Rollback

List deployments, choose the last known-good ID, and roll back:

```powershell
npx.cmd wrangler deployments list
npx.cmd wrangler rollback <KNOWN_GOOD_DEPLOYMENT_ID> --message "rollback after failed knowledge-search smoke"
```

Then repeat the health check and the relevant smoke commands.

## Monitoring

Use these commands for day-2 checks:

```powershell
npx.cmd wrangler queues info line-question-jobs
npx.cmd wrangler queues info knowledge-ingestion-jobs
npx.cmd wrangler tail
npx.cmd wrangler d1 execute line-bot-diagnostics --remote --command "SELECT status, COUNT(*) AS count FROM questions GROUP BY status ORDER BY status"
```
