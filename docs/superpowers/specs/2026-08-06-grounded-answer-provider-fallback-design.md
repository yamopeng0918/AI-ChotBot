# 引用式回答三層供應商備援設計

**日期：** 2026-08-06
**狀態：** 已由使用者核准方案 1，待規格審閱

## 背景與問題

LINE 一般問題目前會先從 Vectorize 與 Tavily 蒐集證據，再由 OpenRouter 產生嚴格 JSON，最後由 `GroundedAnswerService` 驗證引用與事實一致性。正式環境已觀察到 OpenRouter 回傳 401、402、500 以及逾時；任何一次生成失敗都會直接讓使用者收到「目前服務暫時無法使用」。

專案雖已設定 `OPENROUTER_FALLBACK_MODEL`，目前引用式回答路徑只使用 `OPENROUTER_MODEL`。既有 Workers AI 服務也只處理一般問答，未接收檢索證據，因此不能直接作為安全的引用式備援。

## 目標

- 建立三層引用式生成鏈：OpenRouter 主模型、OpenRouter 備援模型、Workers AI。
- 三層使用相同訊息與證據，且輸出都必須通過既有引用驗證。
- 單一供應商失敗時自動繼續，不讓暫時性錯誤直接中斷 LINE 回覆。
- 保留可辨識供應商、模型、失敗原因與切換順序的觀測事件。
- 不改動 Webhook、Queue、D1 schema、LINE 傳送與管理員功能。

## 非目標

- 不增加新的外部 AI 供應商。
- 不改寫檢索路由、證據排序或事實一致性規則。
- 不以未引用的一般回答繞過 `GroundedAnswerService`。
- 不在本次工作中調整模型價格、帳務或 OpenRouter 帳戶設定。

## 方案

### 元件邊界

新增一個可組合的引用式生成器鏈。每個生成器都實作同一介面：接收 `system`／`user` 訊息，回傳 `{ text, model }`。生成器鏈依序嘗試：

1. `OPENROUTER_MODEL`
2. `OPENROUTER_FALLBACK_MODEL`（有設定且不同於主模型時）
3. Cloudflare Workers AI

`GroundedAnswerService` 只依賴這個介面，不需知道供應商切換細節。它仍負責解析 JSON、驗證 evidence ID、引用位置、衝突與逐項事實一致性。

### OpenRouter 行為

OpenRouter 生成器改為可指定單一模型，並將失敗轉成具結構的供應商錯誤，至少保留：

- HTTP 狀態分類
- timeout
- network error
- malformed／empty response

生成器鏈會在所有 OpenRouter 失敗類型後繼續下一層，包括 400、401、402、403、404、429、5xx、逾時與網路錯誤。這可確保設定錯誤或額度問題不會阻止最後一層 Workers AI；錯誤仍只以安全分類寫入觀測紀錄，不寫入回應本文或 Secret。

### Workers AI 引用式生成器

新增 Workers AI 生成器，直接接收 `GroundedAnswerService` 建立的相同訊息，要求模型回傳嚴格 JSON。它不自行建立答案、不跳過驗證，也不使用現有的一般問答 prompt。

Workers AI 模型先採專案既有且已驗證可用的 `@cf/meta/llama-3.2-3b-instruct`，避免新增另一個必要 Secret。若其輸出格式或引用不合格，仍交由 `GroundedAnswerService` 的既有重試與驗證邏輯處理。

### 重試與切換

- 供應商生成呼叫失敗：生成器鏈立即切換下一層。
- 供應商成功回傳但 JSON／引用驗證失敗：`GroundedAnswerService` 保留現有一次修正重試；每次生成請求都從鏈首開始，以維持一致且可預測的優先順序。
- 三層都失敗：拋出供應商不可用錯誤，由現有流程回覆安全的服務不可用文字。
- 生成成功但兩次都未通過引用驗證：維持現有「證據不足」結果，不誤報為供應商故障。

## 資料流

1. Queue consumer 收到問題。
2. Vectorize／D1 檢索本地證據；必要時 Tavily 補充網路證據。
3. `GroundedAnswerService` 建立含不可信證據區塊的嚴格 JSON prompt。
4. 生成器鏈依序嘗試 OpenRouter 主模型、OpenRouter 備援模型、Workers AI。
5. `GroundedAnswerService` 驗證輸出；通過後渲染附來源的 LINE 文字。
6. D1 記錄最終狀態與實際成功模型；遙測記錄每次嘗試與備援切換。

## 觀測與安全

- 每次嘗試記錄 provider、role、model、結果與耗時。
- HTTP 錯誤只記錄安全分類或狀態碼，不記錄 response body、Authorization、API Key 或完整 prompt。
- 進入下一層時記錄 fallback 事件，便於區分主模型、備援模型與 Workers AI。
- D1 `questions.model` 保存最終成功模型；既有 schema 足夠，不新增 migration。
- 所有外部 fetch 都維持請求範圍內建立，並使用 AbortController 清理 timeout。

## 測試策略

依 TDD 先建立會失敗的測試，再做最小實作：

1. OpenRouter 主模型成功時不呼叫其他層。
2. 主模型回傳 500 時，OpenRouter 備援模型成功。
3. 兩個 OpenRouter 模型均失敗時，Workers AI 成功。
4. 主模型 429／逾時時依序切換。
5. 400、401、402、403、404 仍允許 Workers AI 最後備援。
6. 三層都失敗時維持 `provider_unavailable`。
7. Workers AI 回傳不合法 JSON 或無效引用時，不繞過既有驗證。
8. Worker dependency 測試確認 `OPENROUTER_FALLBACK_MODEL` 傳入引用式生成鏈。
9. 既有 OpenRouter、process-message、knowledge-search e2e、typecheck 與 build 全部通過。

## 驗收標準

- OpenRouter 500、429、逾時或帳務／設定錯誤不會直接結束回答流程。
- OpenRouter 備援模型或 Workers AI 任一成功時，LINE 收到通過引用驗證的回答。
- D1 最新問題狀態為 `answered`，並記錄實際成功模型。
- 所有新增與既有相關測試通過，部署 dry-run 與正式健康檢查成功。
- 正式 LINE smoke test 顯示 `answered`，不再回覆服務暫時無法使用。

## 回復策略

若正式驗證失敗，使用 Wrangler 回滾至部署前版本。此設計不含資料庫 migration，因此回滾不需資料修復；既有 Secret 與資源綁定保持不變。
