# Grounded Claim Conflict Pruning Design

## Goal

讓已通過個別安全驗證的 claims 不會因為同一份模型輸出中另有衝突 claim 而全部失效，同時維持 fail-closed 的證據、引用與知識草稿規則。

## Confirmed production symptom and root cause

正式環境的 claims-only 版本已讓 Workers AI 完成兩次生成，但第一次輸出無法解析，第二次輸出因跨 claim 衝突而被整批拒絕。現行 `GroundedAnswerService` 先驗證各 claim，最後只要 `crossClaimConflict` 找到任一衝突組合，就回傳 `conflict`，因此連同不衝突且已有可靠證據的 claims 也一起淘汰。

本次只處理第二次的跨 claim 衝突。JSON 解析失敗仍交由既有第二次修正生成處理，不以猜測或寬鬆解析繞過 schema。

## Safety boundaries

每個 claim 在進入衝突淘汰前，仍須全部通過：

- 至少一個有效且不重複的 evidence ID；
- 可呈現的知識庫位置或 HTTPS 網路來源；
- 同一 claim 引用的 evidence 彼此不衝突；
- claim 文字通過既有 strict entailment 驗證。

任何 claim 未通過上述個別驗證時，整次生成仍依原本原因失敗，不把無效 claim 靜默移除。這可避免模型以大量無效 claims 混入一個有效 claim 來繞過安全閘門。

## Deterministic conflict pruning

完成所有個別驗證後，建立 claims 之間的衝突配對。只有現行 `crossClaimConflict` 會判定為衝突的配對參與淘汰；未衝突的 claims 不受影響。

每個 claim 的來源權威等級取其引用 evidence 的最高等級：知識庫為 2，網路為 1。針對每一組衝突配對：

- 等級較低的一方標記淘汰；
- 等級相同時，雙方都標記淘汰，因系統沒有可靠依據選邊；
- 所有配對一次計算後才套用淘汰，結果不得依 provider 輸出順序而改變。

未被標記的 claims 依原始順序保留，應用程式以一個空白串接文字並只渲染其 citations。`validatedClaims` 與待審知識草稿也只能包含保留項目。

若至少一個 claim 保留，該次生成視為驗證成功。若全部 claims 被淘汰，該次仍回傳 `conflict`，沿用既有第二次修正生成及最終證據不足流程。

## Observability and privacy

成功事件可附加非負整數 `discardedClaimCount`，只表示淘汰數量。不得記錄 question、answer、claim、evidence、URL、模型原始輸出或 LINE 識別資訊。沒有淘汰時省略此欄位或記為零；既有事件名稱、attempt、model 與 failure reason 保持相容。

## Unchanged behavior

- Workers AI-first 與 OpenRouter provider failure fallback 順序；
- 每次請求最多兩次 grounded generation；
- claims-only schema 與 legacy `answer` 忽略規則；
- citation/location/duplicate-ID/conflicting-evidence/entailment 驗證；
- HTTPS Sources 呈現、人工審核及 R2/Queue/Vectorize 發布流程；
- 沒有安全 claim 時回覆 `I don't have enough reliable evidence to answer that.`。

## Verification

以 TDD 覆蓋：

- RED：知識庫 claim 與較低權威網路 claim 衝突時，目前整批失敗；
- GREEN：只保留知識庫 claim，文字、citations 與 `validatedClaims` 均不含網路 claim；
- 相同權威的衝突雙方都淘汰，但不相關的安全 claim 仍保留；
- 全部 claims 因相同權威衝突被淘汰時，維持 `conflict`、重試及最終證據不足；
- 調換衝突 claims 的輸入順序不改變保留集合；
- 個別 citation、location、duplicate-ID、conflicting-evidence 或 entailment 失敗仍使整次生成失敗；
- telemetry 只輸出淘汰數量；草稿只使用保留 claims；
- focused tests、full tests、typecheck、Wrangler dry-run、獨立安全審查與正式 smoke test 全部通過後才能完成。
