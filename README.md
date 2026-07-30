# LINE running-community bot

A Cloudflare Worker that accepts signed LINE group webhooks, queues eligible
mentions, asks Cloudflare Workers AI for a Traditional Chinese running answer,
replies once through LINE, and retains pseudonymized diagnostics in D1 for
30 days.

## Prerequisites and checks

- Node.js 22 or newer and npm.
- A Cloudflare account with Workers AI enabled.
- A LINE Official Account and Messaging API channel.
- The [LINE console runbook](docs/setup/line-messaging-api.md) completed before
  production smoke testing.

Run the local verification gate from the repository root:

```powershell
npm.cmd ci
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

The dry-run must list the `MESSAGE_QUEUE`, `DB`, and `AI` bindings without
deploying.

## Client PowerPoint

Regenerate the editable client project-update deck, then validate its source
coverage, slide geometry, notes, and native editable shapes:

```powershell
python scripts/presentation/build_client_powerpoint.py
python scripts/presentation/verify_client_powerpoint.py
```

The delivery file is
`docs/presentations/AI-ChotBot-project-progress-client.pptx`.

## Provision Cloudflare

1. Authenticate:

   ```powershell
   npx wrangler login
   ```

2. Create the required resources:

   ```powershell
   npx wrangler d1 create line-bot-diagnostics
   npx wrangler queues create line-question-jobs
   npx wrangler queues create line-question-jobs-dlq
   ```

3. Copy the created D1 ID into the `database_id` field in `wrangler.jsonc`.
4. Review the checked-in migrations:

   ```text
   migrations/0001_questions.sql
   migrations/0002_group_admins.sql
   migrations/0003_worker_metrics.sql
   migrations/0004_group_settings_weather_cache.sql
   ```

5. List and apply local migrations:

   ```powershell
   npx wrangler d1 migrations list line-bot-diagnostics --local
   npx wrangler d1 migrations apply line-bot-diagnostics --local
   npx wrangler d1 migrations list line-bot-diagnostics --local
   ```

6. List and apply remote migrations:

   ```powershell
   npx wrangler d1 migrations list line-bot-diagnostics --remote
   npx wrangler d1 migrations apply line-bot-diagnostics --remote
   npx wrangler d1 migrations list line-bot-diagnostics --remote
   ```

`migrations apply` applies every pending migration in filename order. It does
not select an individual file. The first two migrations use bare `CREATE`
statements; reconcile any database whose equivalent objects were created
outside Wrangler migration bookkeeping before applying them.

7. Set every runtime value through Wrangler's encrypted secret store:

   ```powershell
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put LINE_GROUP_ID
   npx wrangler secret put GROUP_ADMINS_BOOTSTRAP_JSON
   npx wrangler secret put ANALYTICS_HASH_KEY
   ```

Notes:

- Use a random, high-entropy `ANALYTICS_HASH_KEY` of at least 32 bytes.
- Keep a recovery copy of `ANALYTICS_HASH_KEY` in the team's secret manager.
- `LINE_GROUP_ID` must be the webhook `source.groupId`, not a group name.
- `GROUP_ADMINS_BOOTSTRAP_JSON` maps each `groupId` to an array of
  `{ userId, displayName }` bootstrap admins.
- `GROUP_ADMINS_BOOTSTRAP_JSON` is bootstrap-only. After the first admin write,
  D1 becomes the source of truth.
- Workers AI is configured through the `AI` binding; no external model API key
  is required.
- The Worker uses a fixed Cloudflare-hosted primary model and a smaller
  Cloudflare-hosted fallback model.
- Keep the bot's existing answer style unchanged when adjusting model
  constants.

Cloudflare references:

- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Queues getting started](https://developers.cloudflare.com/queues/get-started/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Local development

1. Create an uncommitted `.dev.vars` containing the five required secret names.
2. Never use production credentials in a shared checkout.
3. Apply local migrations and start the Worker:

   ```powershell
   npx wrangler d1 migrations apply line-bot-diagnostics --local
   npm.cmd run dev
   ```

4. Require `GET http://localhost:8787/health` to return `{"status":"ok"}`.

A real LINE webhook requires a public HTTPS tunnel whose URL is registered
temporarily in LINE. Restore the production webhook URL afterward.

Weather replies are cached per city in D1 for a short TTL. Group admins can
manage the default weather city in chat with `@bot 設定預設城市 台北`,
`@bot 查看預設城市`, and `@bot 清除預設城市`.

## Observability baseline

Workers Logs use `1.0` head sampling during phase one. Cloudflare Traces are
explicitly disabled.

Traces remain disabled because automatic external `fetch` spans may record
`url.full` and `url.query`, while Open-Meteo receives a user-derived city in
its query. Future trace enablement requires a reviewed, privacy-safe
external-request boundary that prevents user-derived values from appearing in
trace-visible URL attributes. A proxy Worker is not part of phase one.

Production emits allowlisted plain objects to `console.log`, so fields such as
`event`, `webhookEventId`, `operationId`, `stage`, `outcome`, and `errorType`
can be filtered directly in Cloudflare Query Builder.

Follow the
[observability operations runbook](docs/operations/observability.md) for exact
event sequences, Query Builder filters, the privacy audit, migration handling,
production smoke, Version ID recording, and rollback.

## Deployment

Run every step from the repository root. Do not deploy if an earlier gate
fails.

### 1. Install locked dependencies

```powershell
npm.cmd ci
```

### 2. Run the verification gates

```powershell
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

The required order is binding check, tests, typecheck, and dry-run.

### 3. Review and apply pending migrations

Review all pending SQL and require backward compatibility with the currently
deployed Worker. Then run:

```powershell
npx wrangler d1 migrations list line-bot-diagnostics --remote
npx wrangler d1 migrations apply line-bot-diagnostics --remote
npx wrangler d1 migrations list line-bot-diagnostics --remote
```

The second list must show that no checked-in migration remains pending.

### 4. Confirm secrets

Initial setup and deliberate rotation use:

```powershell
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_GROUP_ID
npx wrangler secret put ANALYTICS_HASH_KEY
npx wrangler secret put GROUP_ADMINS_BOOTSTRAP_JSON
```

Do not re-enter unchanged secrets during a routine deploy.

### 5. Record the known-good Worker version

Before deploying, list recent versions:

```powershell
npx wrangler versions list
$knownGoodVersionId = "<VERSION_ID>"
```

Replace the placeholder with the actual currently stable Worker Version ID.
Keep that PowerShell variable available until production smoke passes.

### 6. Deploy

```powershell
npm.cmd run deploy
```

### 7. Run production smoke and record the new version

Run the
[production smoke procedure](docs/operations/observability.md#production-smoke-check).
These checks are production-only and remain pending until a real deployment;
local fake endpoints cannot satisfy them.

After every check passes:

```powershell
npx wrangler versions list
```

Record the newly deployed Version ID in the deployment record. If any check
fails, use the previously recorded `$knownGoodVersionId` in the rollback
procedure.

### Shortest safe deploy sequence

This is the shortest supported sequence; it intentionally retains the dry-run
and migration gate:

```powershell
npm.cmd ci
npm.cmd run types:bindings:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
npx wrangler d1 migrations list line-bot-diagnostics --remote
npx wrangler d1 migrations apply line-bot-diagnostics --remote
npm.cmd run deploy
```

Production smoke and Version ID recording are still required afterward.

## Production smoke check

The full executable procedure is in the
[operations runbook](docs/operations/observability.md#production-smoke-check).
It remains pending until a real deployment.

At minimum:

1. Run `curl.exe https://<worker-host>/health` and require HTTP 200 with
   `{"status":"ok"}`.
2. Send one LINE-native mention with a harmless running question in the allowed
   group and require exactly one visible answer.
3. Send the same words without native mention metadata and confirm no reply.
4. In Query Builder, filter `event Equals webhook.enqueue.completed`,
   `stage Equals webhook`, and `outcome Equals success`; copy the event's
   `webhookEventId`.
5. Query `webhookEventId Equals <copied value>` and require the complete
   applicable success sequence.
6. Inspect only operational D1 fields:

   ```powershell
   npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT webhook_event_id,status,model,created_at,expires_at FROM questions ORDER BY created_at DESC LIMIT 5"
   ```

7. Require one new `answered` row for the eligible event and no row for the
   non-mention.
8. Confirm Queue backlog returns to its prior level.
9. Run the unique weather-marker privacy audit and require zero marker
   occurrences in Logs. Traces are disabled and are not reported as searched.
10. Record the deployed Worker Version ID.

## Key rotation

Rotate one credential at a time:

1. Issue the replacement at LINE, or generate a new analytics HMAC key.
2. Run the matching `npx wrangler secret put NAME`.
3. Run the complete deployment gate and deploy.
4. Run the production health, mention, Dashboard, D1, Queue, and privacy checks.
5. Revoke the old credential only after the replacement is confirmed working.

Notes:

- Rotating `ANALYTICS_HASH_KEY` changes future pseudonyms.
- Retain no mapping for pseudonyms.
- Document the rotation timestamp.
- Update a rotated LINE channel secret immediately; otherwise webhook signature
  validation fails.
- Never print secret values or store them in Git.

## Rollback

Follow the
[observability rollback procedure](docs/operations/observability.md#rollback).
Rollback accepts a Worker Version ID, not a deployment identifier.

```powershell
npx wrangler versions list
$knownGoodVersionId = "<VERSION_ID>"
npx wrangler rollback $knownGoodVersionId --message "rollback after failed smoke"
```

Replace the placeholder with the recorded stable Version ID. Always pass it;
an omitted argument selects the previous uploaded version, which may not be
known-good.

After rollback, repeat production smoke and record the active Version ID.

Worker rollback does not undo D1 migrations, D1 data, or other external
resource state. Migrations must remain backward compatible. If schema recovery
is required, use a separately reviewed D1 backup or Time Travel operation.

See [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
