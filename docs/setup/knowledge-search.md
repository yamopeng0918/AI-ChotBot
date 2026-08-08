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

`OPENROUTER_MODEL` is the primary grounded-answer model. `OPENROUTER_FALLBACK_MODEL` is optional; when present and different from the primary model, provider failures advance to it. Cloudflare Workers AI (`@cf/meta/llama-3.2-3b-instruct`) is always the terminal grounded fallback and still passes through citation validation.

Verify the secret names without printing their values:

```powershell
npx.cmd wrangler secret list
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

## Review web-answer knowledge drafts

Validated web-grounded answers create **pending drafts only**. They are never published automatically. An administrator must review every draft's claims, source credibility, source dates, and copyright/licensing implications before approval. Reject cards that reproduce too much source text, use weak or conflicting sources, or could give unsafe running advice.

Keep the admin token out of command arguments, console output, and PowerShell history. Set `ADMIN_API_TOKEN` outside this runbook's command session (for example through your approved secret manager), then build the header from the environment variable. Do not run `Write-Output`, `echo`, or history commands against the token:

```powershell
$workerHost = "https://<worker-host>"
$adminHeaders = @{ Authorization = "Bearer $env:ADMIN_API_TOKEN" }
```

List pending drafts and inspect one complete card plus its HTTPS provenance before deciding:

```powershell
$pending = Invoke-RestMethod -Method Get -Uri "$workerHost/admin/knowledge/drafts?status=pending&limit=20" -Headers $adminHeaders
$draftId = $pending.drafts[0].id
$detail = Invoke-RestMethod -Method Get -Uri "$workerHost/admin/knowledge/drafts/$draftId" -Headers $adminHeaders
$detail.draft | Select-Object id,status,topic,sources,createdAt,expiresAt
```

After human review, approve or reject exactly one draft:

```powershell
Invoke-RestMethod -Method Post -Uri "$workerHost/admin/knowledge/drafts/$draftId/approve" -Headers $adminHeaders
Invoke-RestMethod -Method Post -Uri "$workerHost/admin/knowledge/drafts/$draftId/reject" -Headers $adminHeaders
```

Approval writes the reviewed Markdown to the existing R2/Queue ingestion pipeline. Check only operational status fields in D1, then inspect the existing ingestion Queue without printing content or credentials:

```powershell
npx.cmd wrangler d1 execute line-bot-diagnostics --remote --command "SELECT status,document_id,created_at,updated_at FROM knowledge_drafts WHERE id='$draftId'; SELECT status,active_version,created_at,updated_at FROM knowledge_documents ORDER BY created_at DESC LIMIT 1"
npx.cmd wrangler queues info knowledge-ingestion-jobs
npx.cmd wrangler queues info knowledge-ingestion-dlq
```

For the knowledge-first smoke, send the same ordinary running question to the configured LINE group twice: first create and approve its pending draft, wait until the document is `ready` and the ingestion Queue is drained, then send the identical question again. Confirm through sanitized telemetry that the second answer used knowledge evidence and did not call Tavily. The dedicated weather flow, administration commands, and greetings are not valid smoke questions for this fallback path.

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
