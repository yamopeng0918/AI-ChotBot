import { describe, expect, test } from "vitest";

import { buildKnowledgeDraft } from "../../src/knowledge/draft-builder";
import type { GroundedAnswer } from "../../src/answers/grounded";
import type { KnowledgeEvidence } from "../../src/knowledge/types";

const now = () => new Date("2026-08-08T00:00:00.000Z");
const web: KnowledgeEvidence = {
  id: "web:1", sourceType: "web", title: "官方跑步指南", url: "https://example.gov/run",
  text: "跑前應循序暖身。 unused snippet", pageNumber: null, sectionPath: null, paragraphIndex: 0,
  retrievedAt: "2026-08-07T12:00:00.000Z", score: 0.9,
};
const knowledge: KnowledgeEvidence = {
  id: "kb:1", sourceType: "knowledge", title: "社群手冊", url: null,
  text: "知識庫內容", pageNumber: 1, sectionPath: "安全", paragraphIndex: null,
  retrievedAt: "2026-08-07T12:00:00.000Z", score: 0.9,
};

function answer(overrides: Partial<GroundedAnswer> = {}): GroundedAnswer {
  return {
    text: "問題：line-user-id-should-not-appear\n\nSources:\n[1] 不可採信的回答來源區塊",
    citations: ["[1] 不可採信的回答來源區塊"], model: "provider/model", usedEvidenceIds: ["web:1"],
    validatedClaims: [{ text: "跑前應循序暖身。", evidenceIds: ["web:1"] }],
    ...overrides,
  };
}

describe("buildKnowledgeDraft", () => {
  test("builds a Traditional Chinese review card from used validated web claims", async () => {
    const built = await buildKnowledgeDraft(answer(), [web], now);

    expect(built).toMatchObject({
      topic: "跑前應循序暖身。",
      sources: [{ title: "官方跑步指南", url: "https://example.gov/run", retrievedAt: "2026-08-07T12:00:00.000Z" }],
    });
    expect(built?.markdown).toContain("## 重點整理");
    expect(built?.markdown).toContain("待管理員審核後才會發布");
    expect(built?.markdown).toContain("醫療專業人員");
    expect(built).toMatchObject({
      createdAt: "2026-08-08T00:00:00.000Z",
      expiresAt: "2026-11-06T00:00:00.000Z",
    });
    expect(built?.markdown).not.toContain("unused snippet");
    expect(built?.markdown).not.toContain("line-user-id-should-not-appear");
    expect(built?.markdown).not.toContain("不可採信的回答來源區塊");
  });

  test("returns null without a used valid web source", async () => {
    await expect(buildKnowledgeDraft(answer({ usedEvidenceIds: [] }), [web], now)).resolves.toBeNull();
    await expect(buildKnowledgeDraft(answer({ usedEvidenceIds: ["kb:1"], validatedClaims: [{ text: "知識庫內容", evidenceIds: ["kb:1"] }] }), [knowledge], now)).resolves.toBeNull();
    await expect(buildKnowledgeDraft(answer(), [{ ...web, url: "http://example.gov/run" }], now)).resolves.toBeNull();
    await expect(buildKnowledgeDraft(answer(), [{ ...web, title: "", url: "not a URL" }], now)).resolves.toBeNull();
  });

  test("uses only selected web evidence and web-supported claims", async () => {
    const unused = { ...web, id: "web:2", title: "未使用來源", url: "https://example.gov/unused", text: "unused snippet" };
    const built = await buildKnowledgeDraft(answer({
      validatedClaims: [
        { text: "跑前應循序暖身。", evidenceIds: ["web:1"] },
        { text: "未使用的知識庫內容。", evidenceIds: ["kb:1"] },
      ],
    }), [unused, knowledge, web], now);

    expect(built?.sources).toEqual([{ title: "官方跑步指南", url: "https://example.gov/run", retrievedAt: "2026-08-07T12:00:00.000Z" }]);
    expect(built?.markdown).toContain("跑前應循序暖身。");
    expect(built?.markdown).not.toContain("未使用的知識庫內容。");
    expect(built?.markdown).not.toContain("未使用來源");
  });

  test("canonicalizes fragment variants and rejects credential-bearing sources without persisting credentials", async () => {
    const fragment = { ...web, id: "web:2", url: "https://EXAMPLE.gov/run#section" };
    const built = await buildKnowledgeDraft(answer({
      usedEvidenceIds: ["web:1", "web:2"],
      validatedClaims: [{ text: "跑前應循序暖身。", evidenceIds: ["web:1", "web:2"] }],
    }), [{ ...web, url: "https://example.gov/run#overview" }, fragment], now);

    expect(built?.sources).toEqual([{ title: "官方跑步指南", url: "https://example.gov/run", retrievedAt: "2026-08-07T12:00:00.000Z" }]);
    expect(built?.markdown).not.toContain("#overview");
    expect(built?.markdown).not.toContain("#section");
    await expect(buildKnowledgeDraft(answer(), [{ ...web, url: "https://user:password@example.gov/run" }], now)).resolves.toBeNull();
  });

  test("renders hostile claims and source metadata as escaped text, never Markdown links or HTML", async () => {
    const hostile = {
      ...web,
      title: "<img src=x> [source](https://attacker.example)",
      url: "https://example.gov/run)",
    };
    const built = await buildKnowledgeDraft(answer({
      validatedClaims: [{ text: "# 偽標題 ![image](https://attacker.example) <script>alert(1)</script>", evidenceIds: ["web:1"] }],
    }), [hostile], now);

    expect(built?.markdown).toContain("\\# 偽標題");
    expect(built?.markdown).toContain("&lt;script&gt;");
    expect(built?.markdown).not.toContain("![image](https://attacker.example)");
    expect(built?.markdown).not.toContain("<img src=x>");
    expect(built?.markdown).not.toContain("[source](https://attacker.example)");
    expect(built?.markdown).not.toContain("](https://");
  });

  test("fails closed when the fixed card template cannot fit the draft Markdown limit", async () => {
    await expect(buildKnowledgeDraft(answer({
      validatedClaims: [{ text: "跑".repeat(65_536), evidenceIds: ["web:1"] }],
    }), [web], now)).resolves.toBeNull();
  });

  test("bounds the topic by Unicode code points and keeps dedupe stable across evidence order", async () => {
    const longTopic = "跑".repeat(122);
    const second = { ...web, id: "web:2", title: "第二來源", url: "https://example.gov/second" };
    const input = answer({
      usedEvidenceIds: ["web:2", "web:1"],
      validatedClaims: [{ text: longTopic, evidenceIds: ["web:2", "web:1"] }],
    });
    const left = await buildKnowledgeDraft(input, [web, second], now);
    const right = await buildKnowledgeDraft(input, [second, web], now);

    expect([...left!.topic]).toHaveLength(120);
    expect(left).toMatchObject({ id: right!.id, dedupeKey: right!.dedupeKey });
    expect(left?.sources.map((source) => source.url)).toEqual(["https://example.gov/run", "https://example.gov/second"]);
  });
});
