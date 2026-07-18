# LINE Messaging API setup

## Create and configure the channel

1. Sign in to [LINE Official Account Manager](https://manager.line.biz/), register a Business ID if prompted, choose **Create new account**, and complete the account form.
2. Open the account, then **Settings > Messaging API > Enable Messaging API**. Select the correct provider carefully: LINE does not let you change the provider later. Messaging API channels can no longer be created directly in Developers Console. Confirm the generated channel under that provider in [LINE Developers Console](https://developers.line.biz/console/). See LINE's [current channel creation guide](https://developers.line.biz/en/docs/messaging-api/getting-started/).
3. In the channel's **Messaging API** tab, enable **Allow bot to join group chats**. LINE allows only one Official Account in a group, so remove another bot first if necessary. See [group chat setup](https://developers.line.biz/en/docs/messaging-api/group-chats/).
4. Under **Channel access token**, issue a token (LINE recommends a v2.1 user-specified-expiration token). Copy it immediately into the `LINE_CHANNEL_ACCESS_TOKEN` Worker secret. Copy **Basic settings > Channel secret** into `LINE_CHANNEL_SECRET`.
5. Deploy the Worker, then set **Webhook URL** to `https://<worker-host>/webhooks/line`. Click **Verify** and require **Success**, enable **Use webhook**, then enable **Webhook redelivery** and acknowledge its warning.
6. In Official Account Manager, open **Settings > Response settings** (the Developers Console link may open it). Disable **Greeting message** and **Auto-response messages** so they do not create unrelated visible replies. LINE documents these defaults in [Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/).

## Select and test the group

1. Invite the Official Account into the designated LINE group.
2. Temporarily enable the narrow discovery mode and start a log tail:

   ```powershell
   '__DISCOVER__' | npx wrangler secret put LINE_GROUP_ID
   npx wrangler deploy
   npx wrangler tail
   ```

3. In the designated group, send one harmless LINE-native mention. The Worker verifies the webhook signature, logs only the `groupId`, and intentionally does not enqueue or reply. It never logs message text or user IDs in this mode. Copy the `groupId` shown by `wrangler tail`; do not use the displayed group name.
4. **Immediately replace the sentinel**—do not leave discovery active, because every valid group webhook is suppressed while `LINE_GROUP_ID` is exactly `__DISCOVER__`:

   ```powershell
   npx wrangler secret put LINE_GROUP_ID
   npx wrangler deploy
   npx wrangler tail
   ```

   At the prompt, paste the real group ID. Send another harmless mention and verify the discovery-only bare group-ID log no longer appears.
5. Mention the Official Account using LINE's mention UI and include a question. Plain text containing `@name` without LINE mention metadata is intentionally ignored.
6. Confirm one visible reply and one D1 row with `status='answered'` (see the README smoke check). A message without a mention and a message from another group must produce neither.

## Delivery guarantees that affect operations

Always validate `x-line-signature` before parsing. LINE can deliver the same event more than once; redelivery preserves `webhookEventId` and the reply token, so this Worker deduplicates on `webhookEventId`. Redelivery is best-effort, not a durable queue guarantee; see [Receive messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/).

A [reply token](https://developers.line.biz/en/reference/messaging-api/#send-reply-message) is single-use and should be used immediately. LINE says normal use beyond one minute is not guaranteed; a redelivered token has additional restrictions, including that it cannot be reused after the original succeeded. Queue delay and OpenRouter latency therefore directly consume the reply window.
