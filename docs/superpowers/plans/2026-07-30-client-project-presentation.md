# 客戶專案成果簡報 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 產出一份讓非技術客戶可理解、可逐頁講解的 14 頁專案成果簡報稿。

**Architecture:** 以單一 Markdown 文件承載投影片內容與講者備註，每頁只有一個主要訊息。先從客戶問題與價值切入，再介紹操作、架構、技術、安全與測試，最後明確區分已完成、開發中及正式環境待驗證的工作。

**Tech Stack:** Markdown、Mermaid、專案 README、Git 紀錄、Vitest 與 TypeScript 驗證結果

## Global Constraints

- 使用繁體中文，主要受眾是沒有工程背景的客戶、決策者及專案窗口。
- 成品是可逐頁說明的 Markdown 簡報稿，每頁都包含投影片文字及講者備註。
- 每項技術名稱都搭配用途或生活化比喻。
- 清楚區分主分支已完成、知識搜尋分支開發中，以及正式環境尚待驗證。
- 不揭露憑證、Token、資料庫識別碼或其他敏感設定。
- 簡報長度適合約 15 至 20 分鐘口頭說明。

---

## File Map

- Create: `docs/presentations/2026-07-30-project-progress-client-presentation.md`
  - 14 頁客戶成果簡報，包含封面、客戶價值、使用情境、系統流程、技術、安全、測試、進度、風險、下一步及逐頁講者備註。

### Task 1: 撰寫 14 頁客戶簡報

**Files:**
- Create: `docs/presentations/2026-07-30-project-progress-client-presentation.md`
- Reference: `docs/superpowers/specs/2026-07-30-client-project-presentation-design.md`
- Reference: `README.md`
- Reference: `docs/notes/2026-07-27-observability-reliability-closeout.md`
- Reference: `.worktrees/knowledge-search/docs/setup/knowledge-search.md`

**Interfaces:**
- Consumes: 已核准的簡報設計規格及目前專案狀態。
- Produces: 以 `---` 分頁、每頁含「講者備註」的 Markdown 簡報稿。

- [ ] **Step 1: 建立封面、問題、解決方案與使用情境頁**

  寫入第 1 至第 4 頁。每頁標題下保留三至五個客戶可讀的短重點，並在頁尾加入一段 60 至 120 字講者備註。

- [ ] **Step 2: 建立系統流程與核心功能頁**

  寫入第 5 至第 6 頁。第 5 頁使用下列層級的 Mermaid 流程，不呈現內部函式名稱：

  ```mermaid
  flowchart LR
      A[使用者在 LINE 提問] --> B[確認訊息安全且符合條件]
      B --> C[排入處理隊伍]
      C --> D[查找資料並請 AI 整理]
      D --> E[把答案回傳至 LINE]
      D --> F[留下不含原文的運作紀錄]
  ```

- [ ] **Step 3: 建立 AI、知識庫與技術頁**

  寫入第 7 至第 9 頁。知識搜尋頁必須標示「開發中，尚未合併至正式主線」；技術頁以「技術、白話角色、帶來的價值」三欄表格呈現 LINE Messaging API、Cloudflare Workers、Queues、Workers AI、D1、R2、Vectorize、Open-Meteo、Tavily、Hono、TypeScript、Vitest 與 Wrangler。

- [ ] **Step 4: 建立安全、測試與完成度頁**

  寫入第 10 至第 12 頁。測試頁記錄 636 項指定測試通過及型別檢查通過，同時揭露完整預設測試曾因知識搜尋 E2E 超過五秒而失敗。完成度頁分成「已完成」、「開發中」、「待正式環境驗證」三區，不使用虛構百分比。

- [ ] **Step 5: 建立風險、下一步與總結頁**

  寫入第 13 至第 14 頁。列出知識搜尋未提交修改、E2E timeout、正式部署與 smoke test、文件中文亂碼及 `deploy-copy/` 清理；下一步依「完成分支 → 自動化驗證 → 合併 → 正式部署 → 實機驗收」排序。

- [ ] **Step 6: 檢查分頁與頁數**

  Run:

  ```powershell
  rg -n "^## 第 [0-9]+ 頁" docs/presentations/2026-07-30-project-progress-client-presentation.md
  ```

  Expected: 依序列出第 1 至第 14 頁，各出現一次。

- [ ] **Step 7: 提交簡報初稿**

  ```powershell
  git add -- docs/presentations/2026-07-30-project-progress-client-presentation.md
  git commit -m "docs: add client project progress presentation"
  ```

### Task 2: 驗證事實、易讀性與交付品質

**Files:**
- Modify: `docs/presentations/2026-07-30-project-progress-client-presentation.md`
- Reference: `README.md`
- Reference: `docs/notes/2026-07-27-observability-reliability-closeout.md`
- Reference: `.worktrees/knowledge-search`

**Interfaces:**
- Consumes: Task 1 的 14 頁簡報初稿。
- Produces: 無敏感資料、無模糊占位、狀態正確且能在 15 至 20 分鐘內講完的定稿。

- [ ] **Step 1: 驗證完成狀態敘述**

  對照主分支、知識搜尋工作樹及 closeout 文件，確認每項成果只出現在正確的「已完成」、「開發中」或「待驗證」區段。

- [ ] **Step 2: 掃描模糊占位與敏感資訊**

  Run:

  ```powershell
  rg -n -i "TODO|TBD|待補|database_id|access[_ -]?token|channel[_ -]?secret|analytics_hash_key" docs/presentations/2026-07-30-project-progress-client-presentation.md
  ```

  Expected: 沒有結果。若需要描述憑證，只能使用「機密憑證」等通用詞彙。

- [ ] **Step 3: 檢查技術名詞是否都有白話解釋**

  逐項檢查 LINE Messaging API、Workers、Queues、Workers AI、D1、R2、Vectorize、Open-Meteo、Tavily、Hono、TypeScript、Vitest 與 Wrangler；每項均須在同一列或同一段說明其用途及客戶價值。

- [ ] **Step 4: 檢查 Markdown 格式**

  Run:

  ```powershell
  git diff --check -- docs/presentations/2026-07-30-project-progress-client-presentation.md
  ```

  Expected: 無輸出且 exit code 為 0。

- [ ] **Step 5: 確認工作區沒有納入無關檔案**

  Run:

  ```powershell
  git status --short
  ```

  Expected: 僅包含本計畫或簡報相關檔案；既有未追蹤的 `deploy-copy/` 維持不變且不加入提交。

- [ ] **Step 6: 提交校訂**

  若校訂產生內容變更：

  ```powershell
  git add -- docs/presentations/2026-07-30-project-progress-client-presentation.md
  git commit -m "docs: refine client presentation accuracy"
  ```

  若沒有內容變更，不建立空提交。
