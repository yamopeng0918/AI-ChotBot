# 城市天氣辨識改善收尾紀錄

## 狀態

城市天氣辨識改善已完成實作、測試、獨立審查、Cloudflare Workers 部署與 LINE 線上驗證。

- 功能分支：`feature/weather-city-recognition`
- 部署日期：2026-08-09（Asia/Taipei）
- Worker：`line-running-community-bot`
- Cloudflare Version ID：`bd21c884-1abd-4c6e-85fa-88851e4e50ea`
- 線上健康檢查：`GET /health` 回覆 `{"status":"ok"}`

## 問題與原因

原始問題句為「請問斗六市明天適合跑步嗎？」。因為句中沒有直接出現「天氣」或「氣象」，舊版意圖路由把它當成一般跑步問題，無法把「斗六市」交給天氣服務查詢。

## 完成內容

- 保留原本明確天氣關鍵字流程。
- 新增「時間詞＋跑步適宜性」的情境式天氣辨識。
- 以確定性規則抽取城市，不把整段聊天內容送到地理編碼服務。
- 地理編碼先查完整行政區名稱，例如 `斗六市`；找不到時只再查一次去除後綴的 `斗六`。
- 候選城市去重且最多兩筆，成功取得有效經緯度後立即停止。
- 訓練菜單、課表與跑量安排等問題仍走一般跑步問答；句中只是提到訓練背景、但實際詢問明日是否適合跑步時，仍走天氣流程。
- 保留原有 Open-Meteo 快取、預設地點、LINE 回覆與隱私安全遙測行為。

## 驗證證據

- 針對性測試：69/69 通過。
- 完整 Vitest：46 個測試檔、655/655 通過。
- TypeScript 與 Wrangler bindings 同步檢查通過。
- `wrangler deploy --dry-run` 成功解析 Queue、D1、Vectorize、R2 與 Workers AI 綁定。
- 最終獨立程式碼複查：無 Critical、Important 或 Minor 發現。
- 正式部署成功，Worker startup time 為 2 ms。
- LINE 重送原始問題後，D1 指標記錄：`intent=weather`、`status=answered`、`model=open-meteo`、`detail=weather`，處理時間 3645 ms。

## 主要提交

- `ccea5d3`：辨識跑步情境中的天氣地點。
- `8dbdbb7`：完整城市名稱失敗時，以去除行政區後綴的名稱重試。
- `9b0d52d`：鎖定情境式天氣路由的整合測試。
- `5d259e3`：避免訓練計畫問題被誤判為天氣。
- `6167c6f`：保留「訓練背景＋實際天氣詢問」的正確路由。

## 後續維運

- 新增行政區或自然語句案例時，優先擴充表格化回歸測試。
- 若 Open-Meteo 地理編碼仍找不到地點，維持最多兩次查詢，避免把完整問題或無限制候選送往外部服務。
- 發布異常時可依 Version ID 查閱 Cloudflare 部署歷史並回復前一版本。
