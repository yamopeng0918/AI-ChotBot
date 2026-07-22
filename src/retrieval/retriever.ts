import type { KnowledgeEvidence } from "../knowledge/types";

export type AuthorizedKnowledgeChunk = {
  vectorId: string; chunkId: string; documentId: string; text: string; displayName: string; sourceUrl: string | null;
  pageNumber: number | null; sectionPath: string | null; paragraphIndex: number | null; segmentIndex: number;
};
export type RetrievalResult = { evidence: KnowledgeEvidence[]; insufficient: boolean; topScore: number | null };
type Embedder = { embed(texts: string[]): Promise<number[][]> };
type VectorQuery = { query(vector: number[], topK: number): Promise<unknown> };
type Authorizer = { authorizeVectorIds(ids: string[]): Promise<AuthorizedKnowledgeChunk[]> };

export class KnowledgeRetriever {
  constructor(private readonly embeddings: Embedder, private readonly vectors: VectorQuery, private readonly repository: Authorizer,
    private readonly options: { scoreThreshold?: number; overlapThreshold?: number; now?: () => string } = {}) {}

  async retrieve(question: string, limit: number): Promise<RetrievalResult> {
    const normalized = question.trim().replace(/\s+/g, " ");
    if (!normalized) throw new RangeError("question must not be empty");
    const evidenceLimit = Math.min(8, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const [embedding] = await this.embeddings.embed([normalized]);
    if (!embedding) throw new Error("query embedding missing");
    const raw = await this.vectors.query(embedding, Math.min(Math.max(evidenceLimit * 4, 20), 50));
    const candidates = parseCandidates(raw, this.options.scoreThreshold ?? .65);
    if (!candidates.length) return { evidence: [], insufficient: true, topScore: null };
    const rows = await this.repository.authorizeVectorIds(candidates.map((candidate) => candidate.id));
    const scores = new Map(candidates.map((candidate) => [candidate.id, candidate.score]));
    const eligible = rows.filter((row) => scores.has(row.vectorId)).sort((a, b) =>
      scores.get(b.vectorId)! - scores.get(a.vectorId)! || a.documentId.localeCompare(b.documentId)
      || nullableNumber(a.pageNumber) - nullableNumber(b.pageNumber) || nullableNumber(a.paragraphIndex) - nullableNumber(b.paragraphIndex)
      || a.segmentIndex - b.segmentIndex || a.chunkId.localeCompare(b.chunkId));
    const kept: AuthorizedKnowledgeChunk[] = [];
    for (const item of eligible) {
      if (kept.some((prior) => prior.documentId === item.documentId && overlaps(prior.text, item.text, this.options.overlapThreshold ?? .85))) continue;
      kept.push(item); if (kept.length === evidenceLimit) break;
    }
    const retrievedAt = (this.options.now ?? (() => new Date().toISOString()))();
    const evidence = kept.map((item): KnowledgeEvidence => ({ id: `${item.chunkId}:${item.vectorId}`, sourceType: "knowledge", title: item.displayName,
      url: item.sourceUrl, text: item.text, pageNumber: item.pageNumber, sectionPath: item.sectionPath,
      paragraphIndex: item.paragraphIndex, segmentIndex: item.segmentIndex, retrievedAt, score: scores.get(item.vectorId)! }));
    const topScore = evidence[0]?.score ?? null;
    return { evidence, insufficient: evidence.length === 0 || topScore === null || topScore < (this.options.scoreThreshold ?? .65), topScore };
  }
}

function parseCandidates(raw: unknown, threshold: number): Array<{ id: string; score: number }> {
  if (!isRecord(raw) || !Array.isArray(raw.matches)) return [];
  const best = new Map<string, number>();
  for (const value of raw.matches) if (isRecord(value) && typeof value.id === "string" && /^[0-9a-f]{64}$/.test(value.id)
    && typeof value.score === "number" && Number.isFinite(value.score) && value.score >= threshold) {
    best.set(value.id, Math.max(best.get(value.id) ?? -Infinity, value.score));
  }
  return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
function overlaps(left: string, right: string, threshold: number): boolean {
  const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const a = normalize(left), b = normalize(right); if (a === b) return true;
  const x = new Set(a.split(/[^\p{L}\p{N}]+/u).filter(Boolean)), y = new Set(b.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const union = new Set([...x, ...y]); if (!union.size) return false;
  let intersection = 0; for (const token of x) if (y.has(token)) intersection++;
  return intersection / union.size >= threshold;
}
function nullableNumber(value: number | null): number { return value ?? Number.MAX_SAFE_INTEGER; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
