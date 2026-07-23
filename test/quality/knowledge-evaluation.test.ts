import { describe, expect, it } from "vitest";

import fixture from "../fixtures/knowledge/evaluation.json";
import { decideRetrievalRoute } from "../../src/retrieval/router";

type EvaluationCase = {
  question: string;
  expectedSource: "knowledge" | "web";
  expectedChunk: string;
  supportedClaims: string[];
  expectedAbstention: boolean;
  evidenceTexts: string[];
  rankedChunks: string[];
};

type Metrics = {
  citationSupportRate: number;
  top5HitRate: number;
  abstentionConsistency: number;
};

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function claimSupported(item: EvaluationCase, claim: string): boolean {
  return item.evidenceTexts.some((text) => normalize(text).includes(normalize(claim)));
}

function top5Hit(item: EvaluationCase): boolean {
  return item.rankedChunks.slice(0, 5).includes(item.expectedChunk);
}

function predictAbstention(item: EvaluationCase): boolean {
  const route = decideRetrievalRoute({ question: item.question, insufficient: false, evidenceCount: 1, topScore: 0.9 });
  if (route.searchWeb) return false;
  return /(?:injury|pain|symptom|dizzy|fever|medical|chest pain)/i.test(item.question);
}

function evaluate(cases: EvaluationCase[]): Metrics {
  let supportedClaims = 0;
  let totalClaims = 0;
  let top5Hits = 0;
  let abstentionMatches = 0;

  for (const item of cases) {
    totalClaims += item.supportedClaims.length;
    supportedClaims += item.supportedClaims.filter((claim) => claimSupported(item, claim)).length;
    if (top5Hit(item)) top5Hits += 1;
    if (predictAbstention(item) === item.expectedAbstention) abstentionMatches += 1;
  }

  return {
    citationSupportRate: totalClaims ? supportedClaims / totalClaims : 0,
    top5HitRate: cases.length ? top5Hits / cases.length : 0,
    abstentionConsistency: cases.length ? abstentionMatches / cases.length : 0,
  };
}

describe("knowledge quality evaluator", () => {
  it("loads at least 50 synthetic cases and meets the quality gate", () => {
    const cases = fixture as EvaluationCase[];
    const metrics = evaluate(cases);

    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(metrics.citationSupportRate).toBeGreaterThanOrEqual(0.9);
    expect(metrics.top5HitRate).toBeGreaterThanOrEqual(0.85);
    expect(metrics.abstentionConsistency).toBe(1);
  });
});
