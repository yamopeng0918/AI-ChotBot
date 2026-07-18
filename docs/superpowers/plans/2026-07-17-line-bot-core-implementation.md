# LINE Bot Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可部署的第一階段垂直切片：只接受指定 LINE 群組內對 bot 的文字 mention，經 OpenRouter 產生安全回答，回覆群組並留下 30 天診斷紀錄。

**Architecture:** 使用 TypeScript Cloudflare Worker 接收 LINE webhook，先驗證簽章與事件範圍，再把工作送入 Cloudflare Queue。Queue consumer 透過可替換的 `AnswerService` 呼叫 OpenRouter，最後使用 LINE reply API 回覆；D1 僅保存被提及的問答與最少診斷資料。

**Tech Stack:** TypeScript 5、Cloudflare Workers、Hono、Cloudflare Queues、D1、Vitest、Wrangler、OpenRouter Chat Completions API、LINE Messaging API。

## Global Constraints

- 第一階段只支援環境變數指定的一個 LINE 群組。
- 只有文字訊息中 `mention.mentionees[].isSelf === true` 時才處理。
- 未提及 bot、其他群組及私訊一律不保存、不呼叫 LLM、不回覆。
- 預設繁體中文、親切跑友語氣；不建立跨訊息記憶。
- 傷病回答只提供一般低風險資訊，警訊時建議停止運動並就醫。
- 找不到可靠資訊時明確說不知道，不捏造來源。
- 問答原文只保存 30 天；不得保存 LINE 顯示名稱、頭像或建立個人輪廓。
- 密鑰只存在 Worker secrets；程式碼、測試 fixture 與 log 不得輸出密鑰。
- 免費額度用盡時安全失敗，不進行無限重試。
- LINE webhook 到 Queue 採至少一次投遞；不得宣稱跨 D1 與 Queue 的原子 exactly-once。
- 使用者端必須嚴格去重：同一 `webhookEventId` 最多採用並保存一份 LLM 結果，且最多產生一次使用者可見的 LINE 回覆；中斷中的工作以具 fencing token 的限時租約恢復。若 Worker 在租約期間被平台暫停，外部 LLM HTTP 請求可能重疊，但 stale 結果不得保存或送出。LINE 官方保證重送事件的 `replyToken` 不變且只能成功使用一次。

## Scope Decomposition

本計畫只實作 LINE 核心問答。後續依序另寫三份計畫：

1. 網路搜尋、知識庫、檔案解析、OCR 與引用。
2. 台灣為主、海外為輔的賽事搜尋。
3. 單一管理員後台、內容管理與完整分析。

核心計畫先定義 `AnswerService` 和事件紀錄介面，後續子系統以工具方式加入，不改變 LINE webhook 邊界。

## File Map

- `package.json`：開發、測試、型別檢查與部署命令。
- `tsconfig.json`：TypeScript 嚴格模式。
- `wrangler.jsonc`：Worker、Queue 與 D1 綁定。
- `src/index.ts`：Worker fetch、queue、scheduled 入口，僅負責組裝依賴。
- `src/config.ts`：環境綁定型別與設定驗證。
- `src/line/types.ts`：本產品使用到的 LINE webhook 最小型別。
- `src/line/signature.ts`：LINE HMAC-SHA256 簽章驗證。
- `src/line/events.ts`：指定群組與 bot mention 篩選。
- `src/line/client.ts`：LINE reply API client。
- `src/answers/types.ts`：`AnswerService` 介面與請求／回應型別。
- `src/answers/prompt.ts`：語氣、語言、醫療與安全系統規則。
- `src/answers/openrouter.ts`：OpenRouter adapter 與錯誤正規化。
- `src/jobs/types.ts`：Queue message schema。
- `src/jobs/process-message.ts`：問答、回覆與紀錄協調器。
- `src/storage/questions.ts`：D1 問答紀錄 repository。
- `migrations/0001_questions.sql`：30 天紀錄資料表與索引。
- `test/*`：與 `src` 邊界對應的 Vitest 測試。
- `docs/setup/line-messaging-api.md`：LINE Official Account、channel、webhook 與群組設定。
- `README.md`：本機測試、秘密設定、migration 與部署操作。

---

### Task 1: Worker scaffold and health endpoint

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `src/config.ts`
- Create: `src/index.ts`
- Create: `test/health.test.ts`

**Interfaces:**
- Produces: `Env` with `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_GROUP_ID`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `MESSAGE_QUEUE`, and `DB`.
- Produces: default Worker export supporting `fetch`, `queue`, and `scheduled` handlers.

- [ ] **Step 1: Add package and compiler configuration**

Create scripts `test`, `test:watch`, `typecheck`, `dev`, and `deploy`. Pin Hono and development dependencies in `package.json`; enable `strict`, `noUncheckedIndexedAccess`, ES2022, and Cloudflare Worker types in `tsconfig.json`.

- [ ] **Step 2: Write the failing health test**

```ts
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("GET /health", () => {
  it("returns a non-secret readiness response", async () => {
    const response = await worker.fetch(new Request("https://bot.test/health"), {} as never, {} as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 3: Run the test and confirm failure**

Run: `npm test -- test/health.test.ts`

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 4: Implement the minimal Hono Worker**

Define `Env` in `src/config.ts`. In `src/index.ts`, create a Hono app with `GET /health` returning `{ status: "ok" }`; export an object whose `fetch` delegates to `app.fetch`. Add queue and scheduled handlers that currently return without side effects so the export shape is stable.

- [ ] **Step 5: Verify the scaffold**

Run: `npm test -- test/health.test.ts`

Expected: 1 test PASS.

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 6: Commit**

```powershell
git add package.json tsconfig.json wrangler.jsonc src/config.ts src/index.ts test/health.test.ts
git commit -m "feat: scaffold LINE bot worker"
```

### Task 2: Verify LINE signatures and select eligible mentions

**Files:**
- Create: `src/line/types.ts`
- Create: `src/line/signature.ts`
- Create: `src/line/events.ts`
- Create: `test/line-signature.test.ts`
- Create: `test/line-events.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `verifyLineSignature(body: string, signature: string, secret: string): Promise<boolean>`.
- Produces: `selectMentionedMessages(payload: LineWebhookBody, allowedGroupId: string): MentionedMessage[]`.
- `MentionedMessage` is `{ webhookEventId: string; replyToken: string; groupId: string; userId: string | null; messageId: string; text: string; timestamp: number }`.

- [ ] **Step 1: Write failing signature tests**

Use a fixed body and secret, calculate the expected base64 HMAC in the test with Web Crypto, and assert that the valid signature returns `true`, a changed body returns `false`, and an empty signature returns `false`.

- [ ] **Step 2: Run signature tests**

Run: `npm test -- test/line-signature.test.ts`

Expected: FAIL because `verifyLineSignature` is missing.

- [ ] **Step 3: Implement constant-time signature verification**

Import an HMAC-SHA256 key with Web Crypto, sign the raw request body, decode the supplied base64 signature, reject length mismatches, and compare every byte without early return.

- [ ] **Step 4: Write failing event-selection tests**

Build fixtures for: valid bot mention, plain text without mention, mention of another user, wrong group, private chat, sticker, and missing `userId`. Assert only the valid mention and valid mention without `userId` are returned; the latter must use `null`.

- [ ] **Step 5: Implement the minimal LINE types and selector**

Model only webhook fields used by the selector. Require `event.type === "message"`, `message.type === "text"`, `source.type === "group"`, matching `groupId`, a non-empty `replyToken`, and at least one mentionee with `isSelf === true`.

- [ ] **Step 6: Add the webhook route**

`POST /webhooks/line` must read the raw body once, require `x-line-signature`, return `401` for invalid signatures, parse JSON only after verification, call the selector, and return `200 { accepted: count }`. Queue sending is added in Task 3.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- test/line-signature.test.ts test/line-events.test.ts`

Expected: all cases PASS.

```powershell
git add src/line src/index.ts test/line-signature.test.ts test/line-events.test.ts
git commit -m "feat: validate LINE mention webhooks"
```

### Task 3: Queue accepted messages with at-least-once delivery

**Files:**
- Create: `src/jobs/types.ts`
- Create: `test/webhook.test.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces: `QuestionJob` equal to `MentionedMessage` plus `receivedAt: string`.
- Consumes: `Env.MESSAGE_QUEUE: Queue<QuestionJob>`.

- [ ] **Step 1: Write failing webhook tests**

Inject a fake queue with a `send` spy. Assert that a signed payload containing one eligible event sends one `QuestionJob` per handler attempt, returns `200`, and never queues ineligible events. Also assert malformed signed JSON returns `400` and a queue exception returns `503` so LINE can redeliver. A redelivered webhook may enqueue the same stable `webhookEventId` again; Task 6 provides consumer-side idempotency so this never becomes a duplicate LLM call or LINE reply.

- [ ] **Step 2: Confirm failure**

Run: `npm test -- test/webhook.test.ts`

Expected: FAIL because accepted messages are not queued.

- [ ] **Step 3: Implement queue publication**

Convert each `MentionedMessage` to `QuestionJob`, set `receivedAt` with ISO UTC time, and call `MESSAGE_QUEUE.send`. Configure a producer and consumer named `line-question-jobs` in `wrangler.jsonc` with `max_batch_size: 5`, `max_batch_timeout: 2`, `max_retries: 2`, and a dead-letter queue.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/webhook.test.ts`

Expected: all webhook cases PASS.

```powershell
git add src/index.ts src/jobs/types.ts test/webhook.test.ts wrangler.jsonc
git commit -m "feat: enqueue eligible LINE questions"
```

### Task 4: Generate bounded answers through OpenRouter

**Files:**
- Create: `src/answers/types.ts`
- Create: `src/answers/prompt.ts`
- Create: `src/answers/openrouter.ts`
- Create: `test/prompt.test.ts`
- Create: `test/openrouter.test.ts`

**Interfaces:**
- Produces: `AnswerRequest` as `{ question: string; locale: "zh-TW" }`.
- Produces: `AnswerResult` as `{ text: string; model: string; inputTokens: number | null; outputTokens: number | null }`.
- Produces: `AnswerService.answer(request: AnswerRequest): Promise<AnswerResult>`.
- Produces: `OpenRouterAnswerService(fetcher, apiKey, model)` implementing `AnswerService`.

- [ ] **Step 1: Write failing prompt-policy tests**

Assert the generated system prompt explicitly contains Traditional Chinese default, friendly running-peer tone, no cross-message memory, uncertainty disclosure, no fabricated citations, medical red flags, and refusal of harmful instructions.

- [ ] **Step 2: Implement the system prompt builder**

Export `buildSystemPrompt(): string` from `src/answers/prompt.ts`. Keep behavioral rules in this single module so later retrieval and race tools reuse the same policy.

- [ ] **Step 3: Write failing OpenRouter adapter tests**

With a fake fetcher, assert the adapter posts to `https://openrouter.ai/api/v1/chat/completions`, sends one system and one user message, sets `max_tokens` to 700, and rejects empty content. Cover HTTP 429 as `AnswerUnavailableError("rate_limited")`, 5xx as `AnswerUnavailableError("provider_error")`, and abort timeout as `AnswerUnavailableError("timeout")`.

- [ ] **Step 4: Implement the OpenRouter adapter**

Use an `AbortController` with a 20-second timeout. Send bearer authentication, model, messages, `temperature: 0.3`, and `max_tokens: 700`. Parse `choices[0].message.content` and optional usage without logging the API key or complete provider payload.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/prompt.test.ts test/openrouter.test.ts`

Expected: all policy and adapter cases PASS.

```powershell
git add src/answers test/prompt.test.ts test/openrouter.test.ts
git commit -m "feat: answer questions through OpenRouter"
```

### Task 5: Reply to LINE and handle provider failures

**Files:**
- Create: `src/line/client.ts`
- Create: `src/jobs/process-message.ts`
- Create: `test/line-client.test.ts`
- Create: `test/process-message.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `LineClient.reply(replyToken: string, text: string): Promise<void>`.
- Produces: `processQuestion(job, dependencies): Promise<ProcessResult>` where result status is `"answered" | "provider_unavailable" | "reply_failed"`.
- Consumes: `AnswerService`, `LineClient`, and the repository added in Task 6 through a temporary no-op recorder interface `QuestionRecorder`.

- [ ] **Step 1: Write failing LINE client tests**

Assert `reply` posts one text message to `https://api.line.me/v2/bot/message/reply`, uses bearer authentication, rejects blank text, and throws a normalized `LineReplyError` for non-2xx responses without exposing the access token.

- [ ] **Step 2: Implement the LINE client**

Limit output to 4,500 Unicode code points before sending, preserving room for LINE limits and a truncation suffix. Never use push messages in this phase.

- [ ] **Step 3: Write failing processor tests**

Assert successful answers call `AnswerService` once and `LineClient.reply` once. Assert rate limit, timeout, and provider errors produce the user message `目前回答服務有點忙，請稍後再 @我 試一次。`. Assert an answer failure is acknowledged rather than retried by the queue; a LINE reply failure throws so the queue retries at most its configured two attempts.

- [ ] **Step 4: Implement the processor and queue consumer**

Construct dependencies in `src/index.ts`. Process each queue message independently. Call `message.ack()` after a successful reply or a successfully delivered provider-unavailable reply; call `message.retry()` only when LINE delivery fails.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/line-client.test.ts test/process-message.test.ts`

Expected: all reply, truncation, degradation, ack, and retry cases PASS.

```powershell
git add src/line/client.ts src/jobs/process-message.ts src/index.ts test/line-client.test.ts test/process-message.test.ts
git commit -m "feat: process and reply to LINE questions"
```

### Task 6: Store minimal 30-day diagnostics and purge expired rows

**Files:**
- Create: `migrations/0001_questions.sql`
- Create: `src/storage/questions.ts`
- Create: `test/questions-repository.test.ts`
- Modify: `src/jobs/process-message.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces: `QuestionRecord` with `webhookEventId`, pseudonymous `userKey`, `question`, `answer`, `status`, `model`, `createdAt`, and `expiresAt`.
- Produces: `QuestionsRepository.claim(webhookEventId, leaseUntilIso): Promise<"claimed" | "completed" | "busy">`, `complete(record): Promise<void>`, `release(webhookEventId): Promise<void>`, and `purgeExpired(nowIso: string): Promise<number>`.
- `userKey` is HMAC-SHA256 of LINE `userId` using a separate `ANALYTICS_HASH_KEY`; when `userId` is unavailable it is `null`.

- [ ] **Step 1: Write the migration**

Create a `questions` table whose primary key is `webhook_event_id`; include nullable `user_key`, question and answer text, constrained status (`processing`, `answered`, `provider_unavailable`, `reply_failed`), nullable `lease_until`, nullable model, `created_at`, `updated_at`, and `expires_at`. Add indexes on `created_at`, `expires_at`, `lease_until`, and `user_key`. Do not include raw LINE user ID, display name, avatar, group conversation history, or access tokens.

- [ ] **Step 2: Write failing repository tests**

Using the Workers D1 test binding, assert the first claim succeeds, a concurrent claim returns `busy`, a completed event returns `completed`, and an expired processing lease can be reclaimed. Assert records do not contain raw user ID, `expiresAt` is exactly 30 days after creation, and purge deletes only expired rows.

- [ ] **Step 3: Implement repository and pseudonymization**

Use parameterized D1 statements. Implement `pseudonymizeUserId(userId, analyticsHashKey)` with Web Crypto HMAC-SHA256 and hex encoding. Do not log question or answer bodies on database errors.

- [ ] **Step 4: Connect recording and scheduled purge**

Before calling the LLM, claim a 60-second processing lease. Ack duplicate completed jobs without another LLM call or LINE reply; retry `busy` jobs after the lease window. Complete `answered`, `provider_unavailable`, and `reply_failed` outcomes atomically with diagnostic fields. Release the claim only when a retryable failure occurs before a LINE reply is accepted. Configure a daily `17 19 * * *` UTC cron trigger, corresponding to 03:17 Asia/Taipei, and call `purgeExpired(new Date().toISOString())` in the scheduled handler.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/questions-repository.test.ts test/process-message.test.ts`

Expected: repository, retention, redaction, and processor cases PASS.

```powershell
git add migrations src/storage src/jobs/process-message.ts src/index.ts wrangler.jsonc test/questions-repository.test.ts test/process-message.test.ts
git commit -m "feat: retain question diagnostics for 30 days"
```

### Task 7: End-to-end contract, setup guide, and deployment gate

**Files:**
- Create: `test/e2e/webhook-to-reply.test.ts`
- Create: `docs/setup/line-messaging-api.md`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Validates the complete public contract: signed LINE webhook in, one LINE reply out, one D1 diagnostic row, no response to ineligible messages.

- [ ] **Step 1: Write the failing end-to-end test**

Use fake OpenRouter and LINE endpoints plus test Queue and D1 bindings. Submit a correctly signed allowed-group mention, drain the queue, and assert exactly one OpenRouter request, one LINE reply, and one stored record. Repeat with a non-mention and wrong group; assert zero calls and zero rows.

- [ ] **Step 2: Run the end-to-end test**

Run: `npm test -- test/e2e/webhook-to-reply.test.ts`

Expected: FAIL until all test bindings and dependency injection paths are wired.

- [ ] **Step 3: Complete dependency injection for tests**

Expose `createWorker(dependencies?)` from `src/index.ts`, defaulting to real adapters in production and accepting fake fetchers, clock, queue, and repository in tests. Keep the default export unchanged for Wrangler.

- [ ] **Step 4: Document LINE and deployment setup**

In `docs/setup/line-messaging-api.md`, give exact console steps to create the LINE Official Account and Messaging API channel, enable group joining, issue a channel access token, set and verify the webhook URL, enable webhooks, disable default greeting/auto-reply behavior that conflicts with the bot, invite the account to the designated group, and test a mention.

In `README.md`, list Node version, `npm install`, `npm test`, `npm run typecheck`, D1 creation and migration commands, Queue creation, every Worker secret, local development, deployment, smoke test, key rotation, and rollback to the previous Worker deployment.

- [ ] **Step 5: Run the full verification gate**

Run: `npm test`

Expected: all tests PASS with zero unhandled promise rejections.

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

Run: `npm run deploy -- --dry-run`

Expected: Wrangler builds the Worker and validates bindings without deploying.

- [ ] **Step 6: Commit**

```powershell
git add src/index.ts test/e2e docs/setup/line-messaging-api.md README.md package.json
git commit -m "docs: add LINE bot deployment runbook"
```

## Completion Criteria

- 全部單元、整合和端對端測試通過。
- 型別檢查與 Wrangler dry run 通過。
- 指定群組 mention 能完成一次真實 smoke test。
- 未 mention、非指定群組與私訊不產生 LLM 呼叫、資料列或回覆。
- D1 不含原始 LINE user ID，排程能移除超過 30 天的原文。
- OpenRouter 或 LINE 暫時失敗時，重試行為有界且不會造成回覆風暴。
- 部署與 LINE 設定可由具基礎程式能力的管理員依文件重做。
