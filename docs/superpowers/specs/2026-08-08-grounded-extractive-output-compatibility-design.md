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

## Approved provider-diagnostic addendum

Production metadata now isolates the terminal failure to the Workers AI binding, but the fallback layer currently collapses every unknown binding exception to `network`. Add a closed, metadata-only diagnostic projection for Workers AI exceptions. It may expose only a normalized error name, a finite numeric provider code, and a valid HTTP status; it must never expose the exception message, stack, prompt, question, answer, evidence, URL, provider payload, LINE identifiers, tokens, authorization values, or secrets. Diagnostic projection must not alter fallback order, response behavior, validation, storage, or publication.

## Approved opaque-error classification addendum

Production proved that the Workers AI binding can reject with no usable name, numeric code, or HTTP status. Inspect either a primitive string rejection or an error object's message only transiently in memory and map exact, documented provider phrases into the closed categories `json_mode_unmet`, `capacity`, `account_limited`, `invalid_model`, `bad_input`, or `unknown`. Only the category may enter `GroundedProviderError` and `attempt.failed`; the original message and exception must never be retained or logged. Property access must remain fail-closed for throwing accessors and Proxies.

## Approved controlled-probe addendum

Stop expanding opaque-error inspection. Add an authenticated `POST /admin/diagnostics/workers-ai-probes` endpoint protected by the existing `ADMIN_API_TOKEN` bearer middleware. It accepts no request body and sequentially runs three fixed, content-free probes against `@cf/meta/llama-3.1-8b-instruct-fast`: plain text generation, a minimal JSON Schema, and the production grounded JSON Schema with fixed synthetic evidence. Return only each probe name, `success` or `failed`, and the existing closed diagnostic category on failure. Never return or log prompt text, model output, raw errors, messages, stack traces, tokens, secrets, or user/LINE data. The ordinary LINE, Queue, fallback, storage, and publication paths remain unchanged.

## Approved progressive-schema probe addendum

The first controlled run proved baseline and minimal JSON Schema succeed while the production grounded schema fails. Replace the single jump to the production schema with four cumulative fixed probes: `nested_shape` adds only the nested answer/claims/evidenceIds types; `closed_required` adds required fields and closed objects; `nonempty` adds `minLength` and `minItems`; `grounded_schema` finally adds `uniqueItems`. Keep the original baseline and simple JSON probes. This isolates the first incompatible constraint group without changing the production answer path or exposing provider content.

## Approved production compatibility fix

The progressive run proved every schema through `nonempty` succeeds and only the final `uniqueItems: true` variant fails. Remove `uniqueItems` only from the Workers AI provider request schema. Do not weaken application validation: `GroundedAnswerService` continues rejecting duplicate evidence IDs as `citation_invalid` before rendering or draft creation. After production verification, remove the temporary authenticated probe route, runner, dependency injection, and probe tests so no diagnostic inference endpoint remains deployed.

## Approved Workers AI-first grounded ordering

Production smoke proved Workers AI structured generation now completes, while the first output can still fail strict entailment and the second corrective generation can be intercepted by a malformed OpenRouter success. Make Workers AI the first grounded generator on every validation attempt. Use configured OpenRouter models only when the Workers AI call itself fails. Preserve the two-attempt validation loop, correction prompt, all strict validation gates, configured OpenRouter model order, telemetry, answer rendering, draft review, and publication behavior.

## Approved claims-only answer derivation

Workers AI-first smoke proved both calls complete but the correction can still fail because the provider's redundant `answer` disagrees with its claims. Make validated claims the sole content source. Request only `claims` from Workers AI; accept both new claims-only output and the legacy OpenRouter `{ answer, claims }` shape, but ignore any provider `answer` value. After every claim passes citation, location, conflict, duplicate-ID, and strict entailment validation, deterministically join claim texts with one space for LINE output and draft content. Keep two attempts, provider failure fallback, source rendering, human approval, and publication gates unchanged.
