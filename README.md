# LINE running-community bot

A Cloudflare Worker that accepts signed LINE group webhooks, queues eligible mentions, asks OpenRouter for a Traditional Chinese running answer, replies once through LINE, and retains pseudonymized diagnostics in D1 for 30 days.

## Prerequisites and checks

- Node.js 20 or newer, npm, a Cloudflare account, a LINE Official Account/Messaging API channel, and an OpenRouter key.
- Follow [the LINE console runbook](docs/setup/line-messaging-api.md) before the production smoke check.

```powershell
npm install
npm test
npm run typecheck
npm run deploy -- --dry-run
```

## Provision Cloudflare

Authenticate with `npx wrangler login`, then create resources:

```powershell
npx wrangler d1 create line-bot-diagnostics
npx wrangler queues create line-question-jobs
npx wrangler queues create line-question-jobs-dlq
```

Copy the D1 ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`. Apply the checked-in migration locally and remotely:

```powershell
npx wrangler d1 migrations apply line-bot-diagnostics --local
npx wrangler d1 migrations apply line-bot-diagnostics --remote
```

Set every runtime value through Wrangler's encrypted secret store (commands prompt without echoing values):

```powershell
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_GROUP_ID
npx wrangler secret put GROUP_ADMINS_BOOTSTRAP_JSON
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENROUTER_MODEL
npx wrangler secret put ANALYTICS_HASH_KEY
```

Use a random, high-entropy `ANALYTICS_HASH_KEY` (at least 32 bytes) and keep its recovery copy in the team's secret manager. `LINE_GROUP_ID` must be the webhook `source.groupId`, not a group name.
`GROUP_ADMINS_BOOTSTRAP_JSON` should be a JSON object that maps each `groupId` to an array of `{ userId, displayName }` bootstrap admins.
`GROUP_ADMINS_BOOTSTRAP_JSON` is bootstrap-only: after the first admin write, D1 is the source of truth and later secret edits do not change live permissions.
`OPENROUTER_MODEL` is the primary answer model. `OPENROUTER_FALLBACK_MODEL` is optional and is only used as a safety net after a provider-style failure on the primary model; it is not a parallel generation path. Keep the bot's existing answer style unchanged when choosing models.

Optional OpenRouter secret:

```powershell
npx wrangler secret put OPENROUTER_FALLBACK_MODEL
```

Cloudflare references: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Queues getting started](https://developers.cloudflare.com/queues/get-started/), and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Local development

Create an uncommitted `.dev.vars` containing the seven required names above. Add `OPENROUTER_FALLBACK_MODEL` only if you want the optional safety-net model locally. Never use production credentials in a shared checkout. Start the Worker and local D1/Queue emulation:

```powershell
npx wrangler d1 migrations apply line-bot-diagnostics --local
npm run dev
```

`GET http://localhost:8787/health` must return `{"status":"ok"}`. A real LINE webhook requires a public HTTPS tunnel and its URL registered temporarily in LINE; restore the production webhook URL afterward.

## Deploy and smoke

Run the gates, apply remote migrations, and deploy:

```powershell
npm test
npm run typecheck
npm run deploy -- --dry-run
npx wrangler d1 migrations apply line-bot-diagnostics --remote
npm run deploy
```

Record the deployment ID printed by Wrangler. With real credentials only, perform this production smoke test:

1. `curl.exe https://<worker-host>/health` and require HTTP 200 with `{"status":"ok"}`.
2. In the allowed group, send one LINE-native mention with a harmless running question. Require exactly one visible answer.
3. Send the same words without mention metadata and confirm no reply.
4. Inspect only operational fields (do not paste user content into tickets):

```powershell
npx wrangler d1 execute line-bot-diagnostics --remote --command "SELECT webhook_event_id,status,model,created_at,expires_at FROM questions ORDER BY created_at DESC LIMIT 5"
```

Require one new `answered` row for the eligible event and no row for the non-mention. This repository's automated gate uses fake endpoints; it is not a production smoke test and cannot validate account credentials.

## Key rotation

Rotate one credential at a time. Issue the replacement at LINE/OpenRouter (or generate a new analytics HMAC key), run the matching `wrangler secret put NAME`, deploy, and perform the health plus eligible-mention smoke checks before revoking the old credential. Rotating `ANALYTICS_HASH_KEY` changes future pseudonyms; retain no mapping and document the rotation timestamp. For a LINE channel-secret rotation, update the Worker secret immediately because webhook signature validation otherwise fails. Never print secret values or store them in Git.

## Rollback

List deployments and roll back to the recorded known-good ID:

```powershell
npx wrangler deployments list
npx wrangler rollback <KNOWN_GOOD_DEPLOYMENT_ID> --message "rollback after failed smoke"
```

Then repeat health and mention smoke checks. Worker rollback does not undo D1 migrations or secret changes. Prefer backward-compatible migrations; if schema recovery is required, follow the D1 backup/restore procedure and treat it as a separate, reviewed database operation. See [Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).
