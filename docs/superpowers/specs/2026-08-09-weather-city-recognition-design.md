# Weather City Recognition Design

## Goal

讓聊天機器人能正確處理「請問斗六市明天適合跑步嗎？」這類沒有直接寫出「天氣」的跑步適宜性問題，並只把乾淨、有限的城市候選送到 Open-Meteo geocoding。

## Confirmed root cause

目前 `classifyIntent()` 只以「天氣、氣象、氣溫、下雨、weather、rain、forecast」等明確字詞判定天氣意圖。實際問題「請問斗六市明天適合跑步嗎？」不含這些字詞，因此被判為一般問題；`extractWeatherLocationQuery()` 也直接回傳 `null`，天氣服務與 geocoding 根本不會執行。

第二個結構性問題是城市抽取採用固定停用詞相減。若句型不在清單內，可能把整段殘留文字送到 geocoding，而不是城市名稱。

## Intent classification

保留既有明確天氣關鍵字。另外，只有同時符合以下兩類訊號時，才把沒有「天氣」字樣的問題判為 weather：

1. 時間訊號：今天、今晚、明天、明早、明晚、後天、本週、週末、現在、目前；
2. 跑步適宜性訊號：適合跑步、適不適合跑步、可以跑步嗎、能不能跑步、適合去跑、跑步適合嗎。

這個雙條件避免把「我適合跑步嗎？」、「如何開始跑步？」等一般訓練問題錯送天氣流程。沒有城市但符合 contextual weather 時，仍沿用群組預設城市；若也沒有預設城市，請使用者提供城市。

## Deterministic city extraction

對已被判為 weather 的文字執行純規則清理：

- 移除 LINE mention、請問／幫我／查詢等禮貌或動作詞；
- 移除明確天氣詞、上述時間詞、跑步適宜性詞與問句標點；
- 壓縮空白；
- 不使用 LLM，不把完整原始問題交給 geocoding。

清理後優先抽取 2 至 8 個中文字符加行政區尾碼的片段：`縣、市、區、鄉、鎮`。例如輸入案例產生主要候選 `斗六市`。若沒有行政尾碼，保留乾淨的中文或拉丁城市名稱，例如 `台北`、`東京`、`Singapore`。

若清理後仍包含無法安全辨識的多餘句子，不猜測其中一段；回傳無城市，改用預設城市或請使用者重述。

## Bounded geocoding fallback

天氣服務最多向 Open-Meteo geocoding 嘗試兩個去重候選：

1. 完整城市候選，例如 `斗六市`；
2. 若候選以 `縣、市、區、鄉、鎮` 結尾，移除一個尾碼後重試，例如 `斗六`。

找到第一筆具有有限 latitude/longitude 的結果後立即停止。兩次皆找不到時，沿用安全的「找不到地點」回覆。英文或本來沒有行政尾碼的城市只查一次。群組預設城市也使用相同的 bounded fallback。

快取 key 仍以主要候選正規化產生；fallback 查得的有效回答可存回該 key。不得把候選城市加入 telemetry、錯誤訊息或 traces。

## Components and interfaces

- `src/intents/router.ts`
  - 擴充 `classifyIntent(text)` 的 contextual weather 規則。
  - 保留 `extractWeatherLocationQuery(text): string | null` 對既有呼叫者相容，回傳主要候選。
  - 新增純函式 `weatherLocationCandidates(location: string): string[]`，回傳最多兩個 geocoding 候選。
- `src/weather/openmeteo.ts`
  - 依候選順序呼叫 geocoding，第一個有效結果即停止。
  - forecast、格式化、快取與安全錯誤處理不變。

## Unchanged behavior

- 明確的中英文 weather 查詢；
- 群組預設城市管理指令與 D1 儲存；
- Open-Meteo forecast 參數與三日輸出；
- weather cache 的 best-effort read/write；
- 一般跑步知識庫、Tavily、Workers AI、草稿審核與發布；
- metadata-only telemetry 和既有隱私限制。

## Verification

以 TDD 覆蓋：

- `請問斗六市明天適合跑步嗎？` 分類為 weather，主要城市為 `斗六市`；
- `斗六市` 產生 `斗六市`、`斗六`，且去重、最多兩項；
- 台北、新北市、高雄、東京、Singapore 的既有或新句型；
- `明天適合跑步嗎？` 使用預設城市，無預設時要求城市；
- `我適合跑步嗎？`、`如何開始跑步？` 仍為 general；
- geocoding 第一候選成功時只呼叫一次；第一候選空結果時以去尾碼候選重試；兩次皆空時安全回覆；
- fallback 成功後 forecast 只呼叫一次並沿用主要候選快取 key；
- provider/cache failure telemetry 不含城市或問題內容；
- intent、weather、process-message、logger、完整測試、typecheck、Wrangler dry-run、獨立審查與 production smoke。

正式 smoke 使用同一問題「請問斗六市明天適合跑步嗎？」。成功條件為 intent=weather、LINE 回覆由 `open-meteo` 產生、不進一般知識問答、且 telemetry 不記錄城市文字。
