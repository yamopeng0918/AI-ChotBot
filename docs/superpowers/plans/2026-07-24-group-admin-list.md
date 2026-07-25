# Group Admin List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-group admin list management to the LINE bot, with `.env` bootstrap data, D1 persistence, and LINE commands for add/remove/list operations.

**Architecture:** Keep D1 as the runtime source of truth. Add a small repository for group-admin storage, a command parser for mention/userId forms, and a webhook router that intercepts admin commands before the normal Q&A queue path. Keep the existing question flow unchanged except for skipping admin-command events.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Wrangler, LINE Messaging API, Vitest.

## Global Constraints

- Each group has its own admin list.
- Only group chats can use admin commands.
- Only listed admins can add/remove/list admins.
- `.env` is bootstrap-only; D1 is the source of truth after the first write.
- Store both `displayName` and `userId`.
- Support both mention-based and `userId`-based commands.
- No private-chat admin control.

---

## File Structure

- `migrations/0002_group_admins.sql` — D1 table and index for per-group admins.
- `src/config.ts` — add the bootstrap env binding for admin seed data.
- `src/admin/group-admins.ts` — D1 repository plus bootstrap parsing and seed logic.
- `src/admin/commands.ts` — parse `管理員新增 / 移除 / 列出` and resolve mention/userId targets.
- `src/admin/router.ts` — classify webhook events as admin commands vs normal question traffic.
- `src/admin/handler.ts` — execute add/remove/list operations and format LINE replies.
- `src/index.ts` — wire the admin pipeline ahead of the existing question queue path.
- `test/admin/group-admins.test.ts` — repository and bootstrap tests.
- `test/admin/commands.test.ts` — command parsing and target resolution tests.
- `test/admin/webhook.test.ts` — end-to-end webhook routing tests for group-only authorization and queue skipping.
- `README.md` and `docs/setup/line-messaging-api.md` — runtime setup and smoke test instructions.

## Task 1: Add D1 storage and bootstrap parsing

**Files:**
- Create: `migrations/0002_group_admins.sql`
- Modify: `src/config.ts`
- Create: `src/admin/group-admins.ts`
- Create: `test/admin/group-admins.test.ts`

**Interfaces:**
- Consumes: `Env.DB`, `Env.GROUP_ADMINS_BOOTSTRAP_JSON`
- Produces:
  - `type GroupAdminSeed = { userId: string; displayName: string }`
  - `type GroupAdminRecord = { groupId: string; userId: string; displayName: string; source: "env" | "bootstrap" | "command"; createdAt: string; updatedAt: string }`
  - `class GroupAdminsRepository`
    - `constructor(db: D1Database, now?: () => string)`
    - `parseBootstrap(raw: string | undefined): Record<string, GroupAdminSeed[]>`
    - `ensureBootstrap(groupId: string, seeds: GroupAdminSeed[], source: "env" | "bootstrap"): Promise<void>`
    - `list(groupId: string): Promise<GroupAdminRecord[]>`
    - `isAdmin(groupId: string, userId: string | null): Promise<boolean>`
    - `upsert(groupId: string, seed: GroupAdminSeed, source: "env" | "bootstrap" | "command"): Promise<void>`
    - `remove(groupId: string, userId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { GroupAdminsRepository } from "../../src/admin/group-admins";

it("parses the bootstrap JSON into per-group seed lists", () => {
  const repo = new GroupAdminsRepository({} as never);
  expect(repo.parseBootstrap(`{"group-1":[{"userId":"U1","displayName":"Alice"}]}`)).toEqual({
    "group-1": [{ userId: "U1", displayName: "Alice" }],
  });
});
```

Add repository tests that prove:

1. `ensureBootstrap()` inserts the first seed for a group.
2. Calling `ensureBootstrap()` twice does not create duplicates.
3. `upsert()` updates `displayName` and `updatedAt` for an existing `(groupId, userId)` pair.
4. `remove()` returns `true` only when a row existed.
5. `isAdmin()` returns `false` for `null` and for unknown users.

Run:

```powershell
npm.cmd test -- test/admin/group-admins.test.ts
```

Expected: fail on missing repository/migration names before implementation.

- [ ] **Step 2: Add the D1 migration**

Create `migrations/0002_group_admins.sql` with:

```sql
CREATE TABLE group_admins (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('env', 'bootstrap', 'command')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_admins_group_id_idx ON group_admins(group_id);
```

- [ ] **Step 3: Implement the repository and env binding**

Update `src/config.ts` so `Env` includes:

```ts
GROUP_ADMINS_BOOTSTRAP_JSON: string;
```

Implement `src/admin/group-admins.ts` to:

- parse the JSON bootstrap map safely,
- seed a group exactly once,
- read admins in stable order by `created_at`, then `user_id`,
- use `PRIMARY KEY (group_id, user_id)` for idempotent upserts,
- return boolean success for `remove()`.

- [ ] **Step 4: Run the repository tests again**

Run:

```powershell
npm.cmd test -- test/admin/group-admins.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the storage layer**

```powershell
git add migrations/0002_group_admins.sql src/config.ts src/admin/group-admins.ts test/admin/group-admins.test.ts
git commit -m "feat: add group admin storage"
```

## Task 2: Parse admin commands and resolve mention/userId targets

**Files:**
- Create: `src/admin/commands.ts`
- Create: `src/admin/router.ts`
- Create: `test/admin/commands.test.ts`

**Interfaces:**
- Consumes:
  - `LineWebhookEvent` from `src/line/types.ts`
  - `GroupAdminSeed` from `src/admin/group-admins.ts`
- Produces:
  - `type AdminCommand = { kind: "add" | "remove" | "list"; target?: GroupAdminSeed; rawText: string }`
  - `function parseAdminCommand(text: string): AdminCommand | null`
  - `function resolveAdminTarget(event: LineWebhookEvent, command: AdminCommand): GroupAdminSeed | null`
  - `function isAdminCommand(event: LineWebhookEvent): boolean`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, it } from "vitest";
import { parseAdminCommand } from "../../src/admin/commands";

it("parses mention-based add and userId-based remove commands", () => {
  expect(parseAdminCommand("@bot 管理員新增 @王小明")).toMatchObject({ kind: "add" });
  expect(parseAdminCommand("@bot 管理員移除 U1234567890abcdef")).toMatchObject({ kind: "remove" });
  expect(parseAdminCommand("@bot 管理員列表")).toMatchObject({ kind: "list" });
});
```

Add tests that prove:

1. Non-admin text returns `null`.
2. Mention-based commands preserve the mention text as the readable label.
3. Direct `userId` commands fall back to the raw `userId` as `displayName` when no alias is present.
4. Commands are case-sensitive only in the exact Chinese action words used in the spec.

Run:

```powershell
npm.cmd test -- test/admin/commands.test.ts
```

Expected: fail until parser logic exists.

- [ ] **Step 2: Implement parsing and routing helpers**

Implement `src/admin/commands.ts` so it:

- accepts only the exact command families `管理員新增`, `管理員移除`, and `管理員列表`,
- extracts a target from either a LINE mention or a trailing `userId`,
- never treats plain group questions as admin commands,
- never tries to infer a target from private messages.

Implement `src/admin/router.ts` so it can classify webhook events into:

- admin command event,
- normal question event,
- ignored event.

- [ ] **Step 3: Run the parser tests again**

Run:

```powershell
npm.cmd test -- test/admin/commands.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit the parser layer**

```powershell
git add src/admin/commands.ts src/admin/router.ts test/admin/commands.test.ts
git commit -m "feat: parse group admin commands"
```

## Task 3: Wire webhook handling, authorization, and LINE replies

**Files:**
- Create: `src/admin/handler.ts`
- Modify: `src/index.ts`
- Modify: `src/line/events.ts`
- Create: `test/admin/webhook.test.ts`
- Modify: `test/webhook.test.ts`

**Interfaces:**
- Consumes:
  - `GroupAdminsRepository`
  - `parseAdminCommand()`, `resolveAdminTarget()`, `isAdminCommand()`
  - `LineClient.reply()`
  - `QuestionJob` queue path
- Produces:
  - `async function handleAdminCommand(...) : Promise<{ handled: boolean; replyText?: string }>`
  - `async function ensureBootstrapForGroup(groupId: string): Promise<void>` or equivalent repository call

- [ ] **Step 1: Write the failing webhook tests**

Add tests that prove:

1. A group admin can add another admin and receive a success reply.
2. A non-admin gets `你沒有權限執行這個指令。`.
3. `管理員列表` returns the current list for the same group.
4. Admin-command events are not queued into `MESSAGE_QUEUE`.
5. Private-chat admin commands are ignored and do not reply.

Run:

```powershell
npm.cmd test -- test/admin/webhook.test.ts test/webhook.test.ts
```

Expected: fail because the webhook handler does not know how to route admin commands yet.

- [ ] **Step 2: Implement the admin handler**

Create `src/admin/handler.ts` so it:

- loads the bootstrap list for the current `groupId` before the first permission check,
- verifies the sender `userId` is already in that group's admin list,
- formats these reply texts:
  - add success: `已新增管理員。`
  - remove success: `已移除管理員。`
  - list success: `目前管理員：...`
  - unauthorized: `你沒有權限執行這個指令。`
  - wrong chat type: `這個指令只能在群組內使用。`
  - not found: `找不到這位管理員。`
  - already exists: `這位管理員已在名單內。`

Update `src/index.ts` so webhook processing does this in order:

1. Verify signature and JSON.
2. For each group text event, check admin-command routing first.
3. Execute admin commands immediately through `LineClient.reply()`.
4. Only send remaining eligible mention events into `MESSAGE_QUEUE`.

Keep normal Q&A queueing untouched for non-admin mentions.

- [ ] **Step 3: Make sure admin commands are excluded from normal Q&A**

Update `src/line/events.ts` or the new router so that admin-command mentions are not returned by the existing question selector.

This must prevent the bot from both:

- replying to the admin command immediately, and
- sending the same event to the question queue.

- [ ] **Step 4: Run webhook tests again**

Run:

```powershell
npm.cmd test -- test/admin/webhook.test.ts test/webhook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the webhook integration**

```powershell
git add src/admin/handler.ts src/index.ts src/line/events.ts test/admin/webhook.test.ts test/webhook.test.ts
git commit -m "feat: wire group admin webhook flow"
```

## Task 4: Update operational docs and validate the full flow

**Files:**
- Modify: `README.md`
- Modify: `docs/setup/line-messaging-api.md`
- Modify: `docs/superpowers/specs/2026-07-24-group-admin-list-design.md` if the implementation forces a spec correction

**Interfaces:**
- Consumes: final env binding name `GROUP_ADMINS_BOOTSTRAP_JSON`
- Produces: operator instructions for bootstrap secret, local dev, deploy, and smoke tests

- [ ] **Step 1: Update the docs with the new secret and command examples**

Add `GROUP_ADMINS_BOOTSTRAP_JSON` to the setup list in `README.md`, and show a bootstrap example like:

```powershell
npx wrangler secret put GROUP_ADMINS_BOOTSTRAP_JSON
```

Document that the JSON value should map `groupId` to an array of `{ userId, displayName }`.

Add the group-admin command examples to `docs/setup/line-messaging-api.md`:

- `@bot 管理員新增 @王小明`
- `@bot 管理員新增 U1234567890abcdef`
- `@bot 管理員移除 @王小明`
- `@bot 管理員列表`

- [ ] **Step 2: Run the full automated gate**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run deploy -- --dry-run
```

Expected: all pass.

- [ ] **Step 3: Apply the new migration and deploy**

Run:

```powershell
npx wrangler d1 migrations apply line-bot-diagnostics --remote
npm.cmd run deploy
```

Expected: deployment succeeds and the worker URL stays unchanged.

- [ ] **Step 4: Smoke-test the live LINE flow**

Use a real group that already has one bootstrap admin. Verify:

1. The bootstrap admin can run `@bot 管理員列表`.
2. The bootstrap admin can add a second admin with either mention or `userId`.
3. The second admin can run `@bot 管理員列表`.
4. A non-admin receives the permission rejection.
5. The normal question flow still works for non-admin bot mentions.

If the worker already has a production health check path, keep it in the smoke sequence:

```powershell
curl.exe https://line-running-community-bot.yamolineaichotbot.workers.dev/health
```

- [ ] **Step 5: Commit the docs**

```powershell
git add README.md docs/setup/line-messaging-api.md
git commit -m "docs: add group admin setup"
```

## Self-Review Checklist

- Spec coverage:
  - Per-group admin list: Task 1 and Task 3.
  - `.env` bootstrap: Task 1 and Task 4.
  - D1 persistence: Task 1.
  - Group-only admin commands: Task 3.
  - Add/remove/list support: Task 2 and Task 3.
  - Store both `displayName` and `userId`: Task 1 and Task 2.
  - Mention and `userId` command support: Task 2.
- Placeholder scan: none. No `TODO`, `TBD`, or “handle edge cases” language remains.
- Type consistency:
  - `GroupAdminSeed`, `GroupAdminRecord`, and `AdminCommand` are defined before later tasks use them.
  - `GROUP_ADMINS_BOOTSTRAP_JSON` is the single env binding name used everywhere.
  - `src/admin/group-admins.ts`, `src/admin/commands.ts`, `src/admin/router.ts`, and `src/admin/handler.ts` are the only new admin modules.
