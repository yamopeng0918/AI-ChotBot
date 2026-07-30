# 技術成果導向 PowerPoint 設計

## 目的

製作一份面向技術主管與決策者的 16 頁 PowerPoint，說明 AI-ChotBot 的系統
架構、技術選型、可靠性、安全、可觀測性、測試成熟度、開發中能力與下一
階段工程投資。簡報需讓具備技術管理背景、但不一定閱讀程式碼的聽眾理解
目前成果及風險。

## 受眾與使用情境

- 對象：客戶技術主管、資訊部門主管、技術決策者及專案負責人。
- 使用方式：20 至 25 分鐘逐頁說明。
- 語言：繁體中文。
- 比例：16:9 寬螢幕。
- 頁數：16 頁。

## 敘事方向

採用「架構成果＋工程治理」：

1. 先以技術成果摘要說明已建立的能力。
2. 再用架構圖與資料流解釋系統如何運作。
3. 接著說明可靠性、安全、觀測與測試如何降低營運風險。
4. 清楚標示知識搜尋仍在開發中。
5. 最後呈現技術成熟度、缺口與工程路線圖。

## 投影片架構

1. 專案與技術成果摘要
2. 技術目標與設計原則
3. 整體系統架構
4. LINE 訊息端到端資料流
5. Cloudflare Workers 執行架構
6. Queue 非同步與可靠性設計
7. AI 回答與模型邊界
8. 天氣資料整合與快取
9. D1 資料模型與生命週期
10. 安全、隱私與機密管理
11. 可觀測性與故障追蹤
12. 自動化測試與品質閘門
13. 知識搜尋技術架構（開發中）
14. 現階段技術成熟度
15. 技術風險與改善計畫
16. 下一階段工程路線圖

## 內容事實基準

主線已具備：

- LINE webhook 簽章驗證、指定群組及原生 mention 判斷；
- Cloudflare Workers、Hono、Queues、Workers AI、D1；
- LINE reply 與 push fallback；
- 管理員與群組設定；
- Open-Meteo 天氣查詢及 D1 快取；
- 結構化觀測事件、相關識別碼及定期清理；
- 自動化測試、型別及部署檢查機制。

資料與隱私：

- Workers Logs 使用去識別化欄位，不寫入訊息原文；
- D1 工作紀錄會暫存問題與回答，用於處理及診斷，最長 30 天後清理；
- 機密值透過 Cloudflare secrets 管理；
- Traces 因外部請求 URL 可能含使用者衍生內容而維持停用。

截至 2026-07-30 的開發環境驗證：

- 主線預設測試 134 項通過；
- 知識搜尋 421 項通過，1 項完整流程測試超過 5 秒；
- 主線的雲端設定型別宣告需要更新，因此上線前檢查尚未全部通過；
- 正式部署、production smoke、LINE 實機、Logs、Queue 及 D1 驗收尚未執行。

知識搜尋位於獨立分支，已有 R2、Vectorize、embeddings、文件與 URL 匯入、
引用式回答、Tavily、生命週期管理及相關測試，但尚未合併至主線或正式部署。

## 視覺設計

沿用專業科技風：

- 深藍背景 `081A2E`；
- 主要文字 `F4F8FC`；
- 青綠重點色 `21D4B4`；
- 藍色 `4BA3FF` 表示資訊；
- 琥珀色 `FFBE55` 表示待驗證；
- 珊瑚紅 `FF6B6B` 表示風險；
- 主要字型 Microsoft JhengHei。

圖形全部使用 PowerPoint 原生可編輯 shape、connector、card 及 label，不使用
外部圖片。架構圖與流程圖的連線方向必須清楚，避免交叉線。

## 特殊視覺

- 第 3 頁：使用者、LINE、Worker、Queue、AI、D1、Open-Meteo 的架構圖。
- 第 4 頁：Webhook 到 LINE 回覆的端到端序列／資料流。
- 第 6 頁：Queue retry、dead-letter queue 及 deduplication 流程。
- 第 9 頁：D1 主要資料類型與 30 天生命週期。
- 第 11 頁：`webhookEventId`／`operationId` 關聯的觀測事件鏈。
- 第 12 頁：測試結果與品質閘門矩陣。
- 第 13 頁：知識搜尋 R2 → ingestion queue → Workers AI → Vectorize →
  retrieval → grounded answer 架構，整頁標示「開發中」。
- 第 14 頁：成熟度矩陣，不使用虛構百分比。
- 第 16 頁：五階段工程路線圖。

## PowerPoint 產生方案

延伸既有 Python 產生架構，但建立獨立來源與成品：

- 來源：
  `docs/presentations/2026-07-30-technical-achievements-presentation.md`
- 產生器：
  `scripts/presentation/build_technical_powerpoint.py`
- 驗證器：
  `scripts/presentation/verify_technical_powerpoint.py`
- 成品：
  `docs/presentations/AI-ChotBot-technical-achievements.pptx`

不覆寫既有客戶價值版 PowerPoint。可重用不綁定特定內容的色票與 shape
輔助函式，但新簡報的來源、頁數、特殊頁契約及測試獨立。

## 驗收標準

- `.pptx` 為合法 Office Open XML，16 頁、16:9。
- 16 頁均有繁體中文標題、主要結論、3 至 5 個重點及講者備註。
- 特殊架構與資料流頁使用原生可編輯圖形。
- 所有已完成、開發中、待驗證及風險狀態與來源一致。
- 主文字及路線節點宣告字級至少 16 pt；密集技術卡至少 12 pt。
- 每頁圖形均在畫布範圍內。
- 不含憑證、Token、資料庫識別碼或其他敏感值。
- 若本機沒有 PowerPoint／LibreOffice renderer，必須明確揭露未完成真實
  渲染，並以 OOXML、邊界、字級、notes 及文字密度檢查替代。

## 成功標準

- 技術主管能理解目前架構、核心技術選擇及系統邊界。
- 決策者能分辨已完成能力、開發中能力與正式環境待驗證事項。
- 簡報能支持技術投資與下一階段優先順序討論。
- 不需要閱讀程式碼即可理解可靠性、安全與營運治理成果。
