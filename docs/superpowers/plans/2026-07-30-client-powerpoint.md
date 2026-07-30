# 客戶專案成果 PowerPoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將已審核的 14 頁 Markdown 客戶簡報轉成專業科技風、可編輯且包含逐頁講者備註的 PowerPoint。

**Architecture:** 使用 Python 3.14 與既有 `python-pptx 1.0.2` 建立 Office Open XML 簡報。產生器先解析固定的 Markdown 來源，再以共用版面函式建立標題、卡片、流程、狀態與路線圖；獨立驗證腳本檢查頁數、標題、備註、敏感資訊與頁面邊界。

**Tech Stack:** Python 3.14、python-pptx 1.0.2、lxml、Pillow、PowerPoint Office Open XML

## Global Constraints

- 內容唯一來源為 `docs/presentations/2026-07-30-project-progress-client-presentation.md`。
- 使用繁體中文、16:9 寬螢幕、14 頁，適合 15 至 20 分鐘客戶簡報。
- 視覺採深藍背景、白色文字及青綠重點色，主要字型為 Microsoft JhengHei。
- 每頁必須有標題、主要結論、三至五個重點及 PowerPoint 講者備註。
- 第 5 頁使用原生圖形流程；第 9 頁呈現 13 項技術；第 14 頁使用五步路線圖。
- 文字、形狀、連接線及狀態標籤保持可編輯，不使用外部圖片。
- 不得加入憑證、Token、資料庫識別碼或其他敏感設定。
- 成品路徑固定為 `docs/presentations/AI-ChotBot-project-progress-client.pptx`。

---

## File Map

- Create: `scripts/presentation/build_client_powerpoint.py`
  - 解析內容、定義主題與版面、建立 14 頁投影片及講者備註。
- Create: `scripts/presentation/verify_client_powerpoint.py`
  - 解析 `.pptx`，驗證結構、文字、備註、敏感資訊及圖形邊界。
- Create: `test/presentation/test_client_powerpoint.py`
  - 驗證 Markdown 解析器、頁面數、標題、備註與特殊頁面契約。
- Create: `docs/presentations/AI-ChotBot-project-progress-client.pptx`
  - 最終可編輯 PowerPoint。
- Modify: `README.md`
  - 補充重新產生與驗證 PowerPoint 的指令。

### Task 1: 建立內容解析器與 PowerPoint 驗證契約

**Files:**
- Create: `scripts/presentation/build_client_powerpoint.py`
- Create: `scripts/presentation/verify_client_powerpoint.py`
- Create: `test/presentation/test_client_powerpoint.py`

**Interfaces:**
- Consumes: UTF-8 Markdown，頁面標題格式 `## 第 N 頁｜標題`、項目符號、Markdown 表格、Mermaid 區塊及 `**講者備註：**`。
- Produces: `parse_markdown(path: Path) -> list[SlideContent]`；`verify_presentation(pptx_path: Path, source_path: Path) -> list[str]`，空清單代表通過。

- [ ] **Step 1: 撰寫解析器失敗測試**

  測試必須確認 14 頁、頁碼依序 1–14、每頁含標題與備註，第 9 頁含 13 筆技術資料。

- [ ] **Step 2: 執行解析器測試確認失敗**

  Run:

  ```powershell
  python -m unittest test.presentation.test_client_powerpoint.MarkdownParserTests -v
  ```

  Expected: FAIL，原因為 `parse_markdown` 尚未建立或尚未符合契約。

- [ ] **Step 3: 實作 Markdown 解析器與資料類別**

  建立 `SlideContent` 與 `TableRow` dataclass；以明確狀態處理普通重點、表格、
  Mermaid 與講者備註，不導入完整 Markdown 引擎。

- [ ] **Step 4: 執行解析器測試確認通過**

  Run:

  ```powershell
  python -m unittest test.presentation.test_client_powerpoint.MarkdownParserTests -v
  ```

  Expected: 所有解析器測試 PASS。

- [ ] **Step 5: 撰寫輸出驗證測試**

  驗證器測試必須檢查：

  - 14 頁及 16:9；
  - 每頁標題與來源一致；
  - 14 頁均有非空白講者備註；
  - 第 5 頁至少六個流程節點；
  - 第 9 頁包含 13 個技術名稱；
  - 第 14 頁包含五個依序標示的步驟；
  - 沒有敏感名稱或超出頁面邊界的圖形。

- [ ] **Step 6: 實作 `verify_presentation`**

  使用 `python-pptx` 讀取投影片與 notes；以 EMU 邊界檢查每個 shape 的
  `left >= 0`、`top >= 0`、`left + width <= slide_width`、
  `top + height <= slide_height`。敏感掃描使用不分大小寫模式：
  `access[_ -]?token|channel[_ -]?secret|analytics_hash_key|database_id`。

- [ ] **Step 7: 提交驗證契約**

  ```powershell
  git add -- scripts/presentation/build_client_powerpoint.py scripts/presentation/verify_client_powerpoint.py test/presentation/test_client_powerpoint.py
  git commit -m "test: define client PowerPoint contract"
  ```

### Task 2: 建立 14 頁專業科技風 PowerPoint

**Files:**
- Modify: `scripts/presentation/build_client_powerpoint.py`
- Modify: `test/presentation/test_client_powerpoint.py`
- Create: `docs/presentations/AI-ChotBot-project-progress-client.pptx`

**Interfaces:**
- Consumes: Task 1 的 `SlideContent`。
- Produces: `build_presentation(source_path: Path, output_path: Path) -> None`，輸出可由 PowerPoint 編輯的 14 頁 `.pptx`。

- [ ] **Step 1: 撰寫版面與特殊頁面失敗測試**

  測試必須確認投影片尺寸為 13.333 × 7.5 英吋、封面具有價值主張、第 5 頁
  具有流程連接線、第 9 頁含技術卡片、第 11 至 13 頁含狀態色、第 14 頁含
  五步路線圖。

- [ ] **Step 2: 實作共用主題與版面函式**

  建立固定色票：

  - `NAVY = "081A2E"`
  - `PANEL = "102B46"`
  - `WHITE = "F4F8FC"`
  - `MUTED = "A9BCD0"`
  - `TEAL = "21D4B4"`
  - `BLUE = "4BA3FF"`
  - `AMBER = "FFBE55"`
  - `CORAL = "FF6B6B"`

  建立標題、頁碼、結論、圓角卡片、狀態標籤、頁尾與文字縮放函式；所有
  中文文字使用 Microsoft JhengHei。

- [ ] **Step 3: 實作一般內容頁**

  第 2、3、4、6、7、8、10、11、12、13 頁使用兩欄或卡片配置，將 Markdown
  重點轉為短句卡片，完整講者文字寫入 notes。

- [ ] **Step 4: 實作特殊頁**

  - 第 1 頁：大標題、一句話價值與三個狀態提示。
  - 第 5 頁：六個原生節點及箭頭，另用兩個資料紀錄卡片說明 Logs 與 D1。
  - 第 9 頁：將 13 項技術分成「主線能力、知識搜尋、工程工具」三區。
  - 第 14 頁：五個依序編號的路線節點及方向線。

- [ ] **Step 5: 寫入講者備註並輸出**

  對每頁取得 `slide.notes_slide.notes_text_frame`，寫入對應 Markdown 講者
  備註，並輸出固定路徑。

- [ ] **Step 6: 執行產生器**

  Run:

  ```powershell
  python scripts/presentation/build_client_powerpoint.py
  ```

  Expected: 建立 `docs/presentations/AI-ChotBot-project-progress-client.pptx`，
  exit code 0。

- [ ] **Step 7: 執行單元測試與結構驗證**

  Run:

  ```powershell
  python -m unittest test.presentation.test_client_powerpoint -v
  python scripts/presentation/verify_client_powerpoint.py
  ```

  Expected: 測試全部 PASS，驗證器輸出 `PowerPoint verification passed: 14 slides`。

- [ ] **Step 8: 提交 PowerPoint**

  ```powershell
  git add -- scripts/presentation/build_client_powerpoint.py test/presentation/test_client_powerpoint.py docs/presentations/AI-ChotBot-project-progress-client.pptx
  git commit -m "docs: generate client PowerPoint deck"
  ```

### Task 3: 視覺檢查與重新產生文件

**Files:**
- Modify: `scripts/presentation/build_client_powerpoint.py`
- Modify: `docs/presentations/AI-ChotBot-project-progress-client.pptx`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 的 `.pptx` 及驗證結果。
- Produces: 完成視覺校訂的 `.pptx` 與可重複執行指令。

- [ ] **Step 1: 檢查可用渲染工具**

  Run:

  ```powershell
  Get-Command libreoffice,soffice,powerpnt -ErrorAction SilentlyContinue
  ```

  Expected: 若找到工具，轉出 PDF 或 PNG 做逐頁視覺檢查；若無結果，記錄為
  無本機 PowerPoint 渲染器，改用結構與 XML 檢查，不聲稱已完成真實渲染。

- [ ] **Step 2: 執行逐頁檢查**

  檢查標題截斷、文字重疊、過小文字、表格密度、流程箭頭及狀態色一致性。
  若無渲染器，以 `python-pptx` 列印每頁 shape 邊界與字級，要求正文不小於
  16 pt、講者畫面主要內容不超出 16:9 邊界。

- [ ] **Step 3: 修正版面並重新輸出**

  只調整產生腳本中的版面、字級、行距或卡片分組，再重新執行產生器；不得
  直接手改二進位 `.pptx`。

- [ ] **Step 4: 更新 README**

  新增「Client PowerPoint」小節及命令：

  ```powershell
  python scripts/presentation/build_client_powerpoint.py
  python scripts/presentation/verify_client_powerpoint.py
  ```

- [ ] **Step 5: 執行最終驗證**

  Run:

  ```powershell
  python -m unittest test.presentation.test_client_powerpoint -v
  python scripts/presentation/verify_client_powerpoint.py
  npm.cmd test -- --exclude ".worktrees/**"
  git diff --check
  ```

  Expected: PowerPoint 測試與結構驗證通過，既有測試無失敗，Git whitespace
  檢查無輸出。

- [ ] **Step 6: 提交視覺校訂與文件**

  ```powershell
  git add -- scripts/presentation/build_client_powerpoint.py docs/presentations/AI-ChotBot-project-progress-client.pptx README.md
  git commit -m "docs: finalize client PowerPoint delivery"
  ```
