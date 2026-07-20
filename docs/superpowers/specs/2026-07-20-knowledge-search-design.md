# 知識庫與網路搜尋子系統設計

日期：2026-07-20  
狀態：待使用者審閱書面規格

## 1. 目標與範圍

本階段在既有 LINE 核心問答垂直切片上加入：

- 自有知識庫檢索
- PDF、Word、純文字、JPEG 與 PNG 匯入
- 繁體中文與英文 OCR
- 單篇公開靜態網址匯入
- 即時網路搜尋與失敗降級
- 可驗證的文件／網址／頁碼／段落引用
- 以單一管理員 API Token 保護的管理 API

初期規模限制為 50 份文件以內；單檔最多 10 MB、100 頁。文件採背景處理，API 顯示等待、處理、完成與失敗狀態。

本階段不包含管理網頁、整站爬取、JavaScript 動態頁、會員內容、網址定期同步、跑步賽事資料模型或多管理員權限。管理網頁與賽事搜尋各自使用獨立規格與實作計畫。

## 2. 核心決策

採 Cloudflare 原生服務為主：

- R2 保存原始檔案
- D1 保存文件、工作、切片文字與來源位置
- Cloudflare Queues 執行非同步匯入
- Workers AI Markdown Conversion 解析文件與圖片
- Workers AI 多語 embeddings 產生向量
- Vectorize 執行相似度檢索
- Tavily 提供即時網路搜尋
- OpenRouter LLM 根據檢索證據產生回答

Cloudflare 元件需透過介面封裝，讓測試可使用 fake／Miniflare，且未來可以替換 OCR、embedding、向量或搜尋供應商。

## 3. 管理 API

所有端點使用 `Authorization: Bearer <ADMIN_API_TOKEN>`。Token 僅存於 Cloudflare Secret，以固定時間比較。驗證失敗統一回傳 `401`，不可透露 Token 是否接近正確。

第一版提供：

- `POST /admin/knowledge/files`：上傳單一文件並建立匯入工作
- `POST /admin/knowledge/urls`：加入單篇公開靜態 HTTPS 網址
- `GET /admin/knowledge/documents`：列出文件與處理狀態
- `GET /admin/knowledge/documents/:id`：查看來源、狀態與錯誤
- `POST /admin/knowledge/documents/:id/reindex`：重新建立索引
- `DELETE /admin/knowledge/documents/:id`：非同步刪除原檔與索引

上傳成功回傳 `202` 與文件 ID。API 不在單次請求內執行轉檔、OCR 或 embedding。

文件狀態：

- `pending`：已接受，等待 Queue
- `processing`：具租約的 worker 正在處理
- `ready`：完整索引已啟用，可供問答
- `failed`：處理失敗，可查看安全化錯誤並重試
- `deleting`：正在刪除，不可供問答

錯誤回應格式固定為 `{ error: { code, message } }`，不回傳供應商 payload、stack、檔案全文或 Secret。

## 4. 匯入資料流程

### 4.1 檔案

1. 驗證管理 Token。
2. 驗證請求為單檔、大小不超過 10 MB。
3. 同時檢查副檔名、宣告 MIME 與 magic bytes。
4. 拒絕可執行檔、加密文件、壓縮炸彈及不支援格式。
5. 原檔以不可預測的 object key 寫入私人 R2 bucket。
6. 在 D1 建立 `pending` 文件與匯入工作。
7. 將只含文件／工作 ID 的訊息送進 ingestion Queue。
8. Queue consumer 取得具 fencing token 的租約，避免 stale worker 發布索引。
9. 使用 Workers AI Markdown Conversion 轉出 Markdown 與頁面結構。
10. 圖片或掃描頁以繁體中文、英文規則處理；品質低於門檻時失敗，不讓 LLM 補猜。
11. 驗證 PDF／Word 頁數不超過 100；超過時標記 `failed` 並刪除暫存索引。
12. 依標題、段落、頁碼切片，保存可重現的位置資訊。
13. 產生 embeddings，先寫入一個新的索引版本。
14. 完成所有 D1 切片與 Vectorize vectors 後，原子切換 active version 並標記 `ready`。

### 4.2 網址

1. 只接受 HTTPS URL。
2. 解析 DNS 並阻擋 loopback、link-local、私有位址、metadata endpoint、非標準私有 IPv6。
3. 每次 redirect 都重新檢查 scheme、host 與解析結果。
4. 拒絕需登入、robots／Content Signals 不允許、非公開或非靜態文章頁。
5. 限制回應大小、redirect 次數與 timeout。
6. 將 HTML 轉成 Markdown，保存原始 URL、擷取時間、標題與段落位置。
7. 後續切片與索引流程與檔案相同。

第一版擷取加入當下的單篇內容，不自動重新擷取、不執行 JavaScript、不追蹤其他連結。

## 5. OCR 與文件品質

- OCR 語言限定繁體中文與英文。
- 純文字 PDF 優先使用原生文字層；只有缺少可用文字層時才走 OCR。
- 保存頁碼、段落序號及文字內容，不保存 LLM 推測的頁碼。
- 對空白、極低信心、亂碼比例過高或嚴重缺頁輸出，將文件標記 `failed`。
- 管理員看到安全化且可行動的原因，例如「掃描解析度不足」或「文件已加密」。
- 原始檔保留於 R2，讓管理員日後重新索引或下載；R2 不提供公開 URL。

## 6. 資料模型

### `knowledge_documents`

- `id`
- `source_type`: `file | url`
- `display_name`
- `source_url`（URL 來源才有）
- `r2_key`（檔案來源才有）
- `status`
- `active_version`
- `content_hash`
- `page_count`
- `error_code`
- `created_at`, `updated_at`

### `knowledge_chunks`

- `id`
- `document_id`
- `index_version`
- `text`
- `page_number`
- `section_path`
- `paragraph_index`
- `vector_id`
- `content_hash`
- `created_at`

### `ingestion_jobs`

- `id`
- `document_id`
- `operation`: `ingest | reindex | delete`
- `status`: `pending | processing | completed | failed`
- `attempt_count`
- `lease_token`, `lease_until`
- `error_code`
- `created_at`, `updated_at`

Vectorize metadata 只保存文件 ID、切片 ID、索引版本與必要篩選欄位。管理 Token、原始 LINE user ID 與文件全文不得寫入 Vectorize metadata。

## 7. Idempotency、版本與刪除

- 上傳工作以 job ID 去重；worker 的狀態變更需帶 fencing token。
- 同一 content hash 可被辨識為重複內容，但第一版不跨文件自動合併，避免意外覆蓋管理員來源。
- 重新索引建立新版本；未完整完成前，舊 active version 持續回答。
- 只有 D1 切片與全部 vectors 成功後才切換 active version。
- stale worker 不得切換版本或刪除新版本資料。
- 刪除先標記 `deleting`，檢索立即排除，再依序清除 Vectorize、D1 切片與 R2 原檔。
- 刪除工作可安全重試；全部完成後再刪除文件 metadata，或保存不含內容的 audit tombstone。

## 8. 檢索與問答協調

### 8.1 路由

每個問題先查知識庫。下列任一條件成立時再查網路：

- 使用者明確要求搜尋或最新資訊
- 問題涉及易變動的日期、活動、價格、人物、規則或新聞
- 知識庫沒有足夠相關內容

不得完全交由 LLM 自由觸發工具；路由器需保留可測試的規則與原因碼。

### 8.2 知識庫檢索

1. 使用與文件相同的 embedding 模型產生 query vector。
2. Vectorize 取回候選切片，只接受 `ready` 文件的 active version。
3. 以相關性重排並去除過度重疊片段。
4. 回傳最多足以支持答案的證據，不把大量無關全文送入 LLM。
5. 證據不足時標記 `insufficient`，不得要求 LLM 猜測。

### 8.3 網路搜尋

- 使用 Tavily basic search；搜尋結果需包含標題、URL、snippet 與取得時間。
- 搜尋有每題查詢數、結果數與 timeout 上限。
- Tavily 額度耗盡、429 或 timeout 時，降級為只查知識庫。
- 降級回答明確說明「目前無法取得即時搜尋結果」。
- 不自動切換其他免費供應商，也不以任意 SERP scraping 備援。

### 8.4 證據與引用

- LLM 只根據檢索證據回答事實性主張。
- 每個重要主張必須對應至少一個引用 ID。
- 知識庫引用顯示文件名稱／原網址及頁碼或段落位置。
- 網路引用顯示頁面標題與 HTTPS URL。
- 回覆產生後執行 citation validator：引用 ID 必須存在、位置與來源一致，且引用片段需支持對應主張。
- validator 失敗時，移除無證據主張並重新產生一次；第二次仍失敗則回答證據不足。
- 不顯示過長原文片段，不捏造作者、頁碼、URL 或來源。
- 自有知識與網路來源衝突時，優先採用較新且較權威的來源，清楚呈現差異與日期。

## 9. 安全與隱私

- 管理 Token 僅存在 Secret；比較使用固定時間函式。
- R2 bucket 私有，object key 不使用可猜測檔名。
- URL fetcher 必須防 SSRF、DNS rebinding、redirect-to-private-IP 與過大回應。
- 外部文件與網頁都是不可信資料；其中的指令不可覆蓋 system prompt、修改工具選擇或取得 Secret。
- 文件處理限制 CPU、記憶體、頁數、輸入大小、輸出文字量與處理時間。
- log 只保存 request／document／job ID、狀態、延遲、供應商與錯誤類型，不保存完整文件、提問、回答、Token 或原始使用者 ID。
- 上傳內容會傳送至 Cloudflare AI 服務；隱私政策需揭露處理目的與第三方。

## 10. 錯誤與降級

- 解析、OCR、embedding、Vectorize、R2、Tavily 各自有 timeout 與分類錯誤。
- retry 只用於 timeout、429、5xx 及明確暫時性錯誤，採指數退避與上限。
- 格式錯誤、加密、超限、低 OCR 品質與永久 4xx 不重試。
- Queue 工作使用 DLQ；免費方案 Queue 訊息保留期限有限，管理文件需包含 DLQ 檢查與重放。
- 供應商額度耗盡時停止密集重試。
- `deleting`、`failed`、非 active version 內容永不進入回答證據。

## 11. 測試策略

### 11.1 單元與整合

- Token 驗證、錯誤格式與 timing-safe comparison
- magic byte／MIME／大小／頁數／加密文件驗證
- URL normalization、SSRF、DNS rebinding 與每次 redirect 重驗
- Markdown 切片、頁碼與段落位置
- idempotent Queue、租約 fencing、stale worker 與索引版本切換
- R2、D1、Workers AI、Vectorize、Tavily adapter timeout／429／5xx
- 刪除部分失敗與安全重試
- prompt injection 內容不影響工具或 system policy

D1 使用 Miniflare 執行真實 migration；Vectorize、R2、Workers AI 與 Tavily 使用契約 fake，Cloudflare staging smoke test再驗證真實 bindings。

### 11.2 品質測試集

建立至少 50 題有標準答案的資料集，每題標記：

- 正確文件或網頁
- 正確頁碼或段落
- 必須支持的主張
- 可接受的「不知道」條件

上線門檻：

- 引用支持率至少 90%
- 知識庫有答案時，Top-5 至少 85% 包含正確來源
- 無充分證據時不捏造答案或引用
- OCR 測試涵蓋繁體中文、英文、混合文字、旋轉與低畫質掃描
- 安全測試全部通過
- 50 份文件內保持免費額度或在達到限制時安全停止

## 12. 部署與營運

- 新增私人 R2 bucket、Vectorize index、Workers AI binding 與 ingestion Queue／DLQ。
- 新增 Tavily 與管理 API secrets。
- D1 migration 需可向前套用，且不得破壞 Phase 1 `questions` 表。
- staging 先以測試文件執行：上傳、處理、檢索、引用、重建與刪除。
- Wrangler dry-run、完整測試、migration 測試及 staging smoke 通過後才可部署。
- 記錄 Workers AI neurons、Vectorize dimensions、R2 儲存／操作、Tavily credits 與 Queue backlog。
- 免費額度不足時，網路搜尋降級；匯入工作暫停並回報明確狀態，不產生無界費用。

## 13. 外部服務依據

- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Vectorize pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI Markdown Conversion: https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/
- Cloudflare Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- Tavily credits and pricing: https://docs.tavily.com/documentation/api-credits
