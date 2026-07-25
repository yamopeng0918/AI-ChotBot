# OpenRouter 回覆延遲與穩定性優化設計

**日期：** 2026-07-25  
**目標：** 在不改變現有回答風格的前提下，降低群組回覆的等待時間，並讓 OpenRouter 偶發失敗時能更穩定地完成回答。

## 1. 問題定義

目前系統的回覆流程是：

1. LINE webhook 進入 Workers。
2. 符合條件的訊息進入 queue。
3. queue consumer 呼叫 OpenRouter 產生答案。
4. 成功後回覆 LINE；失敗時改回 `目前服務暫時無法使用，請稍後再試。`

現況的瓶頸有兩個：

- 主要模型若反應慢，使用者會直接感受到長等待。
- 單一模型失敗時，雖然系統有安全降級，但沒有第二條更穩定的生成路徑，容易把短暫 provider 問題直接變成失敗回覆。

這次優化不做以下事情：

- 不改變對外回答的語氣與長度風格。
- 不加中繼訊息、typing 指示或「處理中」提示。
- 不引入新的外部生成服務。
- 不把同步 webhook 改成串流回覆。

## 2. 設計原則

1. 先保留現有使用者體驗，再改善速度與穩定性。
2. LLM 呼叫維持單一路徑：先主模型，失敗才切 fallback，不做平行多模型比對。
3. 保持失敗模型可預期：只有 transient / provider 類錯誤才切 fallback；正常成功路徑不多做額外工作。
4. 讓設定可調整，但保留現有 `OPENROUTER_MODEL` 相容性，避免一次改壞部署流程。
5. 只改必要檔案，維持 Worker / queue / D1 的既有架構。

## 3. 架構調整

### 3.1 OpenRouter 模型策略

將目前「單一模型」改成「有順序的模型候選清單」：

- 第一順位：主模型，負責大多數請求。
- 第二順位：fallback 模型，只在主模型出現 provider 類失敗時使用。

候選模型的順序由設定決定。若只設定了一個模型，行為與現在一致，但仍保留未來擴充空間。

### 3.2 失敗切換規則

當主模型回應以下情況時，允許切換到 fallback：

- HTTP 429
- HTTP 5xx
- 回應 JSON 無法解析
- 回應內容為空或不是可用文字
- timeout

若 fallback 也失敗，才回到現有的 `provider_unavailable` 降級文字。

### 3.3 延遲控制

這次不改成長時間等待單一慢模型；每次模型嘗試都會有明確 timeout。這樣能把「卡在單一慢 provider」的尾端延遲切短，並讓 fallback 有機會更早接手。

## 4. 設定與相容性

### 4.1 環境變數

保留現有：

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`

新增可選：

- `OPENROUTER_FALLBACK_MODEL`

規則：

- 若只提供 `OPENROUTER_MODEL`，系統只用單一模型。
- 若同時提供 `OPENROUTER_FALLBACK_MODEL`, 系統先試主模型，再試 fallback。
- 若主模型與 fallback 設成相同值，行為上仍視為兩次候選，但不刻意做額外去重。

### 4.2 行為相容性

既有 reply / queue / D1 流程不變。這次只改「答案怎麼生成」，不改：

- webhook 驗證
- 群組過濾
- admin command 路由
- LINE 回覆與 queue 重試規則

## 5. 檔案層級變更

- `src/answers/openrouter.ts`
  - 支援模型候選順序與 fallback。
  - 保留原本回傳的 `AnswerResult` 結構。
  - 把 provider 錯誤正規化成可切 fallback 的型別。

- `src/config.ts`
  - 新增 `OPENROUTER_FALLBACK_MODEL`。

- `src/index.ts`
  - 把主模型與 fallback 模型傳入 answer service。

- `test/openrouter.test.ts`
  - 驗證主模型成功、主模型失敗後 fallback 成功、兩者都失敗時的降級行為。

- `test/process-message.test.ts`
  - 驗證 queue consumer 在 provider fallback 後仍會照原流程完成回覆與持久化。

- `README.md` 或 `docs/setup/line-messaging-api.md`
  - 補上新設定項與建議的模型選擇說明。

## 6. 成功標準

1. 主模型成功時，回答風格與現有版本一致，沒有額外同步等待。
2. 主模型失敗時，系統會自動切到 fallback，不讓單一 provider error 直接變成使用者失敗。
3. 兩個模型都失敗時，仍維持原本的安全降級文案。
4. 既有測試涵蓋主路徑與 fallback 路徑，且不破壞 admin / queue / LINE webhook 行為。
5. 設定仍可只用 `OPENROUTER_MODEL` 運作，不強迫既有部署立刻補第二個模型。

## 7. 驗證方式

實作完成後需要驗證：

- `npm.cmd test -- test/openrouter.test.ts test/process-message.test.ts`
- `npm.cmd run typecheck`
- 真實部署前用現有 LINE 測試群組送一則 mention，確認：
  - 主模型成功時能正常回覆
  - 人為切換到失敗模型時，fallback 能接手
  - 回覆內容沒有變短、變硬或變成中繼訊息

