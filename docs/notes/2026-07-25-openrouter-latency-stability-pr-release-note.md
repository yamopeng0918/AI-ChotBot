## PR Description

### Current status

這個版本已完成以下調整：

- LINE bot 可在指定群組內處理有效 mention 並回覆
- 回答模型已遷移至 Cloudflare Workers AI
  - 使用 `wrangler.jsonc` 的 `AI` binding，不需要 OpenRouter API key
  - 主模型發生 timeout 或 provider 類型錯誤時，才切換至較小的 Cloudflare-hosted fallback 模型
- 新增即時天氣查詢、每群組預設城市與 D1 短期快取
- 新增 Worker 遙測資料與每日清理排程
- 回答風格維持原樣，沒有加入「處理中」中繼訊息
- 文件已同步更新為目前的 Workers AI 部署方式

### Operational notes

- 部署前需套用 `0003_worker_metrics.sql` 與 `0004_group_settings_weather_cache.sql`
- 必須保留 `AI`、`DB` 與 `MESSAGE_QUEUE` bindings
- 天氣資料由 Open-Meteo 提供；供應商回傳的當地時間不應再次套用時區
- 正式環境仍需執行 README 所列的 health、mention 與 D1 smoke checks

### Verification

- `npm.cmd test`
- `npm.cmd run typecheck`
- `npm.cmd run deploy -- --dry-run`
