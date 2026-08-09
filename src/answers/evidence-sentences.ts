import type { KnowledgeEvidence } from "../knowledge/types";

const MAX_SENTENCES_PER_EVIDENCE = 5;
const MAX_SENTENCE_CANDIDATES = 30;
const SENTENCE_PATTERN = /[^\r\n.!?。！？;；]+(?:[.!?。！？;；]+|(?=\r?\n|$))/gu;

export type SentenceCandidate = {
  id: string;
  text: string;
  evidence: KnowledgeEvidence;
};

export function buildSentenceCandidates(evidence: KnowledgeEvidence[]): SentenceCandidate[] {
  const candidates: SentenceCandidate[] = [];
  for (const item of evidence) {
    const sentences = splitSentences(item.text).slice(0, MAX_SENTENCES_PER_EVIDENCE);
    for (const text of sentences) {
      if (candidates.length === MAX_SENTENCE_CANDIDATES) return candidates;
      candidates.push({ id: `s${candidates.length}`, text, evidence: item });
    }
  }
  return candidates;
}

function splitSentences(text: string): string[] {
  return (text.match(SENTENCE_PATTERN) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
}
