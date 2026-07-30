# 技術成果導向 PowerPoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 產出一份面向技術主管與決策者的 16 頁架構成果與工程治理 PowerPoint。

**Architecture:** 先建立獨立的 16 頁繁中 Markdown 內容與技術版驗證契約，再以 Python 3.14、python-pptx 1.0.2 產生可編輯的架構圖、資料流、矩陣及路線圖。重用既有客戶版的通用解析與樣式輔助能力，但技術版來源、特殊頁契約、測試、驗證器及 `.pptx` 獨立。

**Tech Stack:** Python 3.14、python-pptx 1.0.2、lxml、Pillow、PowerPoint Office Open XML、Vitest

## Global Constraints

- 成品固定為 16 頁、16:9、繁體中文，適合 20 至 25 分鐘。
- 來源固定為 `docs/presentations/2026-07-30-technical-achievements-presentation.md`。
- 成品固定為 `docs/presentations/AI-ChotBot-technical-achievements.pptx`。
- 色票固定為深藍 `081A2E`、主要文字 `F4F8FC`、青綠 `21D4B4`、藍 `4BA3FF`、琥珀 `FFBE55`、珊瑚紅 `FF6B6B`。
- 主要字型固定為 Microsoft JhengHei。
- 每頁必須有標題、來源結論、3 至 5 個來源重點及講者備註。
- 主文字及路線節點至少 16 pt；密集技術卡至少 12 pt。
- 架構、資料流與路線圖使用 PowerPoint 原生可編輯 shape 及 connector。
- 不覆寫既有 `AI-ChotBot-project-progress-client.pptx`。
- 已完成、開發中、待驗證與風險狀態必須與設計規格事實基準一致。
- 不得包含憑證、Token、資料庫識別碼或其他敏感值。
- 沒有 PowerPoint／LibreOffice renderer 時，不得宣稱完成真實畫面渲染。

---

## File Map

- Create: `docs/presentations/2026-07-30-technical-achievements-presentation.md`
  - 16 頁技術成果簡報來源與逐頁講者備註。
- Create: `scripts/presentation/build_technical_powerpoint.py`
  - 產生 16 頁可編輯技術 PowerPoint。
- Create: `scripts/presentation/verify_technical_powerpoint.py`
  - 驗證來源、內容、notes、特殊頁、狀態、字級、主題、邊界與敏感資訊。
- Create: `test/presentation/test_technical_powerpoint.py`
  - 技術版解析、產生器、驗證器及特殊頁契約測試。
- Create: `docs/presentations/AI-ChotBot-technical-achievements.pptx`
  - 最終 PowerPoint。
- Modify: `README.md`
  - 補充技術版重新產生與驗證命令。

### Task 1: 建立 16 頁技術內容與驗證契約

**Files:**
- Create: `docs/presentations/2026-07-30-technical-achievements-presentation.md`
- Create: `scripts/presentation/verify_technical_powerpoint.py`
- Create: `test/presentation/test_technical_powerpoint.py`

**Interfaces:**
- Consumes: 設計規格、README、observability closeout、operations runbook、主線與知識搜尋分支現況。
- Produces: 16 頁 Markdown；`verify_technical_presentation(pptx_path: Path, source_path: Path) -> list[str]`。

- [ ] **Step 1: 撰寫 16 頁繁中來源**

  每頁使用 `## 第 N 頁｜標題`、3 至 5 個 `-` 重點及一段
  `**講者備註：**`。依規格固定的 16 頁順序撰寫，不加入未由專案證據支持的
  SLO、效能數字、正式上線或成功部署聲明。

- [ ] **Step 2: 撰寫來源解析失敗測試**

  測試 16 頁、頁碼 1–16、標題、每頁 3–5 重點、notes、繁中內容，以及第
  13 頁明確含「開發中」。

- [ ] **Step 3: 執行來源測試確認 RED**

  ```powershell
  python -m unittest test.presentation.test_technical_powerpoint.TechnicalSourceTests -v
  ```

  Expected: FAIL，因來源或技術驗證器尚未完成。

- [ ] **Step 4: 實作技術版驗證器骨架**

  重用 `build_client_powerpoint.parse_markdown` 及不綁定 14 頁內容的 shape
  走訪方式，但技術版必須獨立要求 16 頁及固定特殊頁 shape names。

- [ ] **Step 5: 建立特殊頁驗證契約**

  驗證：

  - 第 3 頁至少七個 `architecture-node-` 及原生 connector；
  - 第 4 頁至少六個 `message-flow-step-`；
  - 第 6 頁包含 retry、DLQ 及 deduplication 原生節點；
  - 第 9 頁包含 D1 工作紀錄、天氣快取、群組設定、metrics 及 30-day lifecycle；
  - 第 11 頁含 webhookEventId、operationId 及至少五個 observability event；
  - 第 12 頁含主線 134、知識搜尋 421、1 項逾時及上線前檢查待更新；
  - 第 13 頁含 R2、ingestion queue、Workers AI、Vectorize、retrieval、grounded answer，且具有 `development-status-`；
  - 第 14 頁使用具名成熟度矩陣，不接受百分比；
  - 第 16 頁 `roadmap-step-1` 至 `roadmap-step-5` 各一次。

- [ ] **Step 6: 提交來源與契約**

  ```powershell
  git add -- docs/presentations/2026-07-30-technical-achievements-presentation.md scripts/presentation/verify_technical_powerpoint.py test/presentation/test_technical_powerpoint.py
  git commit -m "test: define technical PowerPoint contract"
  ```

### Task 2: 產生 16 頁可編輯技術 PowerPoint

**Files:**
- Create: `scripts/presentation/build_technical_powerpoint.py`
- Modify: `test/presentation/test_technical_powerpoint.py`
- Create: `docs/presentations/AI-ChotBot-technical-achievements.pptx`

**Interfaces:**
- Consumes: Task 1 的 16 頁 Markdown 與既有客戶版通用色票／shape 輔助方式。
- Produces: `build_technical_presentation(source_path: Path, output_path: Path) -> None`。

- [ ] **Step 1: 撰寫產生器端到端失敗測試**

  使用暫存路徑呼叫 `build_technical_presentation`，再要求
  `verify_technical_presentation(...) == []`。

- [ ] **Step 2: 建立共用技術版面**

  使用 13.333 × 7.5 英吋、固定色票、Microsoft JhengHei、頁碼、標題、來源
  結論、3–5 個來源重點、逐頁可見青綠 accent 及來源 notes。

- [ ] **Step 3: 建立架構與資料流頁**

  第 3、4、5、6 頁使用原生節點與 connector；箭頭需由左至右或由上至下，
  不建立無法判斷方向的裝飾線。

- [ ] **Step 4: 建立資料、治理與品質頁**

  第 7 至 12 頁使用模型邊界卡、快取流程、D1 生命週期、隱私分層、事件鏈及
  品質閘門矩陣。第 12 頁不得將開發測試描述成正式環境驗收。

- [ ] **Step 5: 建立知識搜尋、成熟度、風險與路線圖**

  第 13 頁整頁標示開發中；第 14 頁以狀態矩陣呈現、不使用百分比；第 15 頁
  對應風險與改善行動；第 16 頁使用五個精簡路線節點，完整文字保留於來源
  重點與 notes。

- [ ] **Step 6: 產生與驗證**

  ```powershell
  python scripts/presentation/build_technical_powerpoint.py
  python -m unittest test.presentation.test_technical_powerpoint -v
  python scripts/presentation/verify_technical_powerpoint.py
  ```

  Expected: 建立 16 頁 PowerPoint，測試通過，驗證器輸出
  `Technical PowerPoint verification passed: 16 slides`。

- [ ] **Step 7: 提交技術版 PowerPoint**

  ```powershell
  git add -- scripts/presentation/build_technical_powerpoint.py test/presentation/test_technical_powerpoint.py docs/presentations/AI-ChotBot-technical-achievements.pptx
  git commit -m "docs: generate technical achievements PowerPoint"
  ```

### Task 3: 可讀性、OOXML 與交付文件

**Files:**
- Modify: `scripts/presentation/build_technical_powerpoint.py`
- Modify: `scripts/presentation/verify_technical_powerpoint.py`
- Modify: `test/presentation/test_technical_powerpoint.py`
- Modify: `docs/presentations/AI-ChotBot-technical-achievements.pptx`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 成品及技術版驗證器。
- Produces: 結構、字級、邊界、notes、OOXML 及 README 均驗證完成的交付版本。

- [ ] **Step 1: 檢查渲染工具**

  ```powershell
  Get-Command libreoffice,soffice,powerpnt -ErrorAction SilentlyContinue
  ```

  若無結果，在 README 與報告中明確記錄沒有真實渲染，不得聲稱視覺播放
  已驗收。

- [ ] **Step 2: 執行 fallback 檢查**

  以 python-pptx／ZIP／lxml 驗證：

  - 16 頁及每頁 notes；
  - 每個 shape 在畫布範圍內；
  - 主文字、架構節點及路線節點至少 16 pt，密集卡片至少 12 pt；
  - OOXML CRC、XML／rels 可解析；
  - 無圖片、外部關聯、VBA 或媒體檔；
  - 每頁文字密度與具名節點數在契約範圍內。

- [ ] **Step 3: 校訂並重新產生**

  只修改產生器，重新輸出 `.pptx`；不得直接修改二進位檔。

- [ ] **Step 4: 更新 README**

  新增技術版命令：

  ```powershell
  python scripts/presentation/build_technical_powerpoint.py
  python scripts/presentation/verify_technical_powerpoint.py
  ```

  保留既有客戶版命令及 renderer 限制說明。

- [ ] **Step 5: 最終驗證**

  ```powershell
  python -m unittest test.presentation.test_client_powerpoint test.presentation.test_technical_powerpoint -v
  python scripts/presentation/verify_client_powerpoint.py
  python scripts/presentation/verify_technical_powerpoint.py
  npm.cmd test -- --exclude ".worktrees/**"
  git diff --check
  ```

  Expected: 兩份 PowerPoint 測試及驗證全部通過，既有測試無失敗，Git
  whitespace 檢查無輸出。

- [ ] **Step 6: 提交交付校訂**

  ```powershell
  git add -- README.md scripts/presentation/build_technical_powerpoint.py scripts/presentation/verify_technical_powerpoint.py test/presentation/test_technical_powerpoint.py docs/presentations/AI-ChotBot-technical-achievements.pptx
  git commit -m "docs: finalize technical PowerPoint delivery"
  ```
