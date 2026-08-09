import { describe, expect, it } from "vitest";
import { buildSentenceCandidates } from "../../src/answers/evidence-sentences";
import type { KnowledgeEvidence } from "../../src/knowledge/types";

function evidence(id: string, text: string): KnowledgeEvidence {
  return { id, sourceType: "web", title: id, url: `https://example.com/${id}`, text, pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-08-09", score: .8 };
}

describe("buildSentenceCandidates", () => {
  it("preserves sentence text and assigns stable request-local IDs", () => {
    const source = evidence("web:1", "  First sentence. Second sentence！\n\nThird sentence?  ");

    const result = buildSentenceCandidates([source]);

    expect(result.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "s0", text: "First sentence." },
      { id: "s1", text: "Second sentence！" },
      { id: "s2", text: "Third sentence?" },
    ]);
    expect(result.every((candidate) => candidate.evidence === source)).toBe(true);
    expect(source.text).toBe("  First sentence. Second sentence！\n\nThird sentence?  ");
  });

  it("keeps at most five sentences from each evidence", () => {
    const result = buildSentenceCandidates([evidence("web:1", "One. Two. Three. Four. Five. Six.")]);

    expect(result.map((candidate) => candidate.text)).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
  });

  it("keeps at most thirty candidates across all evidence", () => {
    const sources = Array.from({ length: 7 }, (_, index) => evidence(`web:${index}`, "One. Two. Three. Four. Five."));

    const result = buildSentenceCandidates(sources);

    expect(result).toHaveLength(30);
    expect(result.at(-1)?.id).toBe("s29");
    expect(result.at(-1)?.evidence.id).toBe("web:5");
  });
});
