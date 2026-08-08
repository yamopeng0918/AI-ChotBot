# Grounded Extractive Output Compatibility Design

## Goal

讓 Workers AI 在不放寬 citation、conflict、location 或 entailment 安全檢查的前提下，穩定產生可驗證的 web-grounded 回答與待審知識草稿。

## Confirmed production symptom

- Tavily／grounded 路徑已被選用，最終模型為 `@cf/meta/llama-3.2-3b-instruct`。
- 兩次生成後仍回傳 `I don't have enough reliable evidence to answer that.`。
- 沒有建立草稿；D1、Queue 與草稿儲存均未發生錯誤。

## Design

1. Parser 僅額外接受「整個輸出被單一 Markdown `json` code fence 包住」的情況；fence 外若有任何文字仍拒絕。
2. System prompt 明確要求每個 `claim.text` 必須逐字複製某一 cited evidence 的完整句子，不得翻譯、摘要或改寫；`answer` 必須等於 claims 依序以單一空白串接。
3. Grounded service 產生 metadata-only validation events，分類為 `parse_invalid`、`answer_claim_mismatch`、`citation_invalid`、`location_invalid`、`conflict` 或 `entailment_failed`。事件不得包含 question、answer、claim、evidence、URL、snippet、provider payload 或 token。
4. 既有兩次生成、provider fallback、strict entailment、HTTPS citation、衝突檢查與人工草稿審核流程全部維持。

## Verification

- TDD 證明 fenced strict JSON 由失敗轉通過，fence 外文字仍拒絕。
- Prompt contract test 鎖定逐字摘錄與 answer join 規則。
- Telemetry type/runtime tests 鎖定只有 attempt、reason、model 等 metadata。
- 跑 grounded、process-message、logger、knowledge E2E、完整測試、typecheck、Wrangler dry-run。
- 部署後重送同題，預期 LINE 回傳有 HTTPS Sources、D1 出現 pending draft；未經管理員核准前不入庫。

## Approved structured-output fallback addendum

Production metadata confirmed both attempts still failed with `parse_invalid`: OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free`, then Workers AI `@cf/meta/llama-3.2-3b-instruct`. The current Workers AI fallback is therefore replaced with the Cloudflare JSON Mode-supported `@cf/meta/llama-3.1-8b-instruct-fast` and receives a strict `response_format` JSON Schema for exactly `{ answer, claims[] }` and `{ text, evidenceIds[] }`. OpenRouter remains first priority. The existing parser and every evidence validation gate remain mandatory even when the provider reports schema compliance.
