# LINE running-community bot

A Cloudflare Worker that accepts signed LINE group webhooks, queues eligible mentions, asks Cloudflare Workers AI for a Traditional Chinese running answer, replies once through LINE, and retains pseudonymized diagnostics in D1 for 30 days.

## Prerequisites and checks

- Node.js 20 or newer, npm, a Cloudflare account, a LINE Official Account/Messaging API channel, and Cloudflare Workers AI enabled on the target account.
- Follow [the LINE console runbook](docs/setup/line-messaging-api.md) before the production smoke check.

```powershell
npm install
npm run types:bindings:check
npm test
npm run typecheck
npm run deploy -- --dry-run
```

## Provision Cloudflare

1. Authenticate with `npx wrangler login`.
2. Create the required resources:

```powershell
npx wrangler d1 create line-bot-diagnostics
npx wrangler queues create line-question-jobs
npx wrangler queues create line-question-jobs-dlq
```

3. Copy the D1 ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
4. Apply the checked-in migration locally and remotely:

```powershell
npx wrangler d1 migrations apply line-bot-diagnostics --local
npx wrangler d1 migrations apply line-bot-diagnostics --remote
```

5. Set every runtime value through Wrangler's encrypted secret store:

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
- `GROUP_ADMINS_BOOTSTRAP_JSON` must be a JSON object that maps each `groupId` to an array of `{ userId, displayName }` bootstrap admins.
- `GROUP_ADMINS_BOOTSTRAP_JSON` is bootstrap-only: after the first admin write, D1 becomes the source of truth and later secret edits do not change live permissions.
- Cloudflare Workers AI is configured through the `ai` binding in `wrangler.jsonc`; no external API key is required for the reply model.
- The current worker uses a fixed Cloudflare-hosted model in code and falls back to a smaller Cloudflare-hosted model on provider-style failure.
- Keep the bot's existing answer style unchanged when adjusting the model constants.

Cloudflare references:

- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Queues getting started](https://developers.cloudflare.com/queues/get-started/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Local development

1. Create an uncommitted `.dev.vars` containing the five required names above.
2. No OpenRouter secret is needed for local development.
3. Never use production credentials in a shared checkout.
4. Start the Worker and local D1/Queue emulation:

```powershell
npx wrangler d1 migrations apply line-bot-diagnostics --local
npm run dev
```

- `GET http://localhost:8787/health` must return `{"status":"ok"}`.
- A real LINE webhook requires a public HTTPS tunnel and its URL registered temporarily in LINE.
- Restore the production webhook URL afterward.
- Weather replies are cached per city in D1 for a short TTL, so repeated asks for the same city should be faster than the first lookup.
- Group admins can manage the default weather city in the group chat with `@bot 設定預設城市 台北`, `@bot 查看預設城市`, and `@bot 清除預設城市`.

## Deployment

This project runs on Cloudflare Workers. Use the commands below from the repository root.

### 1) Install dependencies

```powershell
npm install
```

### 2) Verify the code before deploy

```powershell
npm run types:bindings:check
npm test
npm run typecheck
npm run deploy -- --dry-run
```

### 3) Set required secrets

Set runtime values through Wrangler's encrypted secret store:

```powershell
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_GROUP_ID
npx wrangler secret put ANALYTICS_HASH_KEY
npx wrangler secret put GROUP_ADMINS_BOOTSTRAP_JSON
```

Notes:

- `LINE_GROUP_ID` must be the webhook `source.groupId`, not the group name.
- `ANALYTICS_HASH_KEY` should be random, high-entropy, and at least 32 bytes.
- `GROUP_ADMINS_BOOTSTRAP_JSON` should be a JSON object that maps each `groupId` to an array of `{ userId, displayName }` bootstrap admins.
- `GROUP_ADMINS_BOOTSTRAP_JSON` is bootstrap-only: after the first admin write, D1 becomes the source of truth and later secret edits do not change live permissions.
- Cloudflare Workers AI is configured through the `ai` binding in `wrangler.jsonc`; no external API key is required for the reply model.
- The worker uses a fixed Cloudflare-hosted model in code and falls back to a smaller Cloudflare-hosted model on provider-style failure.

### 4) Deploy

```powershell
npm run deploy
```

### 5) Check logs after deploy

```powershell
npx wrangler tail
```

During the initial baseline phase, Workers Logs use 100% sampling and Traces use 10% sampling. Follow the [observability operations runbook](docs/operations/observability.md) for Dashboard inspection and privacy auditing.

### 6) If you only need the shortest deploy sequence

```powershell
npm install
npm test
npm run typecheck
npm run deploy
```

## Production smoke check

After a real deployment, follow the [observability operations runbook](docs/operations/observability.md#production-smoke-check) and validate the live bot with production credentials only. These production-only checks remain pending until a real deployment; local fake endpoints cannot satisfy them.

1. `curl.exe https://<worker-host>/health` and require HTTP 200 with `{"status":"ok"}`.
2. In the allowed group, send one LINE-native mention with a harmless running question. Require exactly one visible answer.
3. Send the same words without mention metadata and confirm no reply.
4. Inspect only operational fields:

```powershell
npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT webhook_event_id,status,model,created_at,expires_at FROM questions ORDER BY created_at DESC LIMIT 5"
```

Checks:

- Require one new `answered` row for the eligible event.
- Require no row for the non-mention.
- The repository's automated gate uses fake endpoints; it is not a production smoke test and cannot validate account credentials.

## Key rotation

Rotate one credential at a time:

1. Issue the replacement at LINE, or generate a new analytics HMAC key.
2. Run the matching `wrangler secret put NAME`.
3. Deploy the Worker.
4. Run the health check and eligible-mention smoke checks.
5. Revoke the old credential only after the new one is confirmed working.

Notes:

- Rotating `ANALYTICS_HASH_KEY` changes future pseudonyms.
- Retain no mapping for pseudonyms.
- Document the rotation timestamp.
- For a LINE channel-secret rotation, update the Worker secret immediately because webhook signature validation otherwise fails.
- Never print secret values or store them in Git.

## Rollback

Follow the [observability rollback procedure](docs/operations/observability.md#rollback).

1. List deployments and roll back to the recorded known-good ID:

```powershell
npx wrangler deployments list
npx wrangler rollback <KNOWN_GOOD_DEPLOYMENT_ID> --message "rollback after failed smoke"
```

2. Repeat the health and mention smoke checks.

Notes:

- Worker rollback does not undo D1 migrations or secret changes.
- Prefer backward-compatible migrations.
- If schema recovery is required, follow the D1 backup/restore procedure and treat it as a separate, reviewed database operation.
- See [Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).
