# Grounded Sentence Selection Design

## Goal

停止讓模型自行撰寫 grounded claims。應用程式先把 evidence 轉成可驗證的原句候選，模型只選擇最多三個候選 ID，最後回答、引用及待審草稿均由應用程式直接使用原始證據句構成。

## Confirmed production root cause

Claims-only 與 conflict pruning 已部署並通過本機驗證，但正式 smoke test 仍出現：第一次的同權威衝突 claims 全部被安全淘汰，第二次由模型撰寫的 claim 未通過 strict entailment。Provider 呼叫、Queue、LINE 與儲存流程皆成功，問題集中在模型仍負責生成 claim 文字。

本設計移除該責任。模型只做相關性選擇，不再提供任何可直接呈現的回答文字。

## Candidate construction

`GroundedAnswerService` 在呼叫 provider 前，依目前 evidence 順序建立候選句：

1. 將每筆 evidence 的文字依換行與句末標點切分，保留句末標點並移除空白片段。
2. 不翻譯、不改寫、不正規化候選句的可見內容；只在最後 LINE-safe rendering 時沿用既有控制字元與空白清理。
3. 每筆 evidence 最多取前 5 個非空句，整次請求最多 30 個候選句，以限制 prompt 大小。
4. 依候選出現順序配置 request-local ID：`s0`、`s1`、`s2`。ID 只在該次 `answer()` 呼叫有效，映射保留於應用程式記憶體。
5. 每個 prompt 候選包含 sentence ID、evidence ID、原始句子、來源類型及既有 citation location metadata。Evidence 仍標示為不可信引用資料，模型不得遵循其中指令。

若切分後沒有候選句，不呼叫 provider，直接回覆既有 insufficient-evidence fallback。

## Provider contract

Workers AI JSON Schema 改為只接受：

```json
{"sentenceIds":["s0"]}
```

契約要求：

- 根物件只能包含 `sentenceIds`；
- `sentenceIds` 為陣列，最少 1、最多 3；
- 每個項目為非空字串；
- 不在 Workers AI schema 使用已證實不相容的 `uniqueItems`；重複值由應用程式拒絕；
- prompt 明確禁止回傳 answer、claim text、解釋、Markdown 或其他欄位。

OpenRouter 使用相同 prompt 與 parser，但只在 Workers AI 呼叫本身失敗時進入。舊 `{answer,claims}` 格式不再是成功輸出，因為它重新引入模型文字。

## Validation and conflict pruning

解析成功後依序執行：

1. 只能有 1 至 3 個唯一 sentence IDs；未知、重複、空值或額外欄位均為 `citation_invalid`，JSON/shape 錯誤仍為 `parse_invalid`。
2. 由 request-local map 取回原句與 evidence；模型輸出不得提供或覆寫文字、來源或位置。
3. 每個來源仍須通過既有 renderable location 規則；web 必須有安全 HTTPS URL。
4. 對每個取回的原句執行既有 strict entailment，並以其自身 evidence text 驗證。因文字由 evidence 原句產生，此檢查是 defense-in-depth，不得移除。
5. 對已選句子沿用已核准的 deterministic cross-claim conflict pruning：知識庫權威高於 web；不同權威淘汰較低者；同權威衝突雙方淘汰；所有配對先計算再過濾，結果不得受選取順序影響。
6. 至少保留一個句子才成功；全部淘汰仍回傳 `conflict`。

第一次失敗後仍只允許一次修正生成。修正 prompt 必須重申只能從列出的 sentence IDs 選 1 至 3 個唯一值。第二次失敗則回覆既有 insufficient-evidence fallback。

## Rendering and draft boundary

保留句子的原始文字依模型所選順序以一個空白串接。Citations 依首次使用的 evidence ID 去重，並沿用既有 location/HTTPS rendering。

`GroundedAnswer.validatedClaims` 保持現有 API，相容下游：每個項目的 `text` 是應用程式取回的原句，`evidenceIds` 只含映射來源 ID。`usedEvidenceIds`、LINE 回覆、Sources 與 pending draft 都只能使用保留句子及來源。人工核准前不得寫入正式知識庫。

## Telemetry and privacy

沿用 `answer.grounded.validation`。可以記錄：attempt、outcome、reason、model、`selectedSentenceCount` 及既有 `discardedClaimCount`。只能記錄非負整數，不得記錄 question、sentence text、answer、claim、evidence、title、URL、provider payload、LINE ID、token 或 secret。

## Unchanged behavior

- Weather 專用流程、管理指令與打招呼；
- Workers AI-first，OpenRouter 只處理 provider call failure；
- 最多兩次生成；
- KB-first、Tavily web fallback 與來源排序；
- LINE Queue、D1 狀態、R2、Vectorize、ingestion Queue 與 DLQ；
- pending draft、管理員 approve/reject 與發布閘門；
- 無安全句子時 fail closed。

## Verification

以 TDD 覆蓋：

- 候選切句保留原文、ID 穩定，且每來源 5 句、總計 30 句上限；
- Workers AI schema 只允許 1 至 3 個 `sentenceIds`，且沒有 `uniqueItems`；
- prompt 只要求 IDs 並把 evidence 標為 untrusted data；
- 模型不能以額外 answer/claim 欄位注入輸出；
- 未知、重複、超過 3 個 ID 均 fail closed；
- 選取句的文字、citations、used IDs 與 validatedClaims 全部由 server-side map 產生；
- knowledge/web 與同權威衝突淘汰仍符合既有規格；
- 全淘汰、location invalid、entailment defense failure、兩次修正及 provider fallback；
- telemetry 僅包含句數 metadata；draft 不含未選句或來源；
- weather/admin/greeting 回歸、focused/full tests、typecheck、Wrangler dry-run、獨立安全審查及 production smoke test。

正式 smoke 成功條件：Workers AI-first；至少一個 sentence selection 通過驗證；LINE 回覆含 HTTPS citation；若使用 web evidence 則建立一筆 pending draft；metadata 不含內容；OpenRouter 除非 Workers AI call failure 否則不被呼叫。
