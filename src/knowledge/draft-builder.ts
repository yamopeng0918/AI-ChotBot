import type { GroundedAnswer, GroundedClaim } from "../answers/grounded";
import type { CreateKnowledgeDraftInput, KnowledgeDraftSource } from "./drafts";
import type { KnowledgeEvidence } from "./types";

export type BuiltKnowledgeDraft = CreateKnowledgeDraftInput;

const TOPIC_LIMIT = 120;
const MARKDOWN_LIMIT = 65_536;
const DRAFT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Builds review-only knowledge content from the claim/evidence boundary that
 * GroundedAnswerService has already validated. It deliberately ignores the
 * rendered answer and citations, which are presentation rather than provenance.
 */
export async function buildKnowledgeDraft(
  answer: GroundedAnswer,
  evidence: KnowledgeEvidence[],
  now: () => Date,
): Promise<BuiltKnowledgeDraft | null> {
  const sourcesById = selectedWebSources(answer.usedEvidenceIds, evidence);
  if (!sourcesById) return null;

  const claims = webSupportedClaims(answer.validatedClaims, sourcesById);
  if (!claims.length) return null;
  const topic = topicFor(claims[0]!.text);
  if (!topic) return null;

  const sources = canonicalSources(sourcesById.values());
  if (!sources.length) return null;
  const markdown = renderMarkdown(topic, claims, sources);
  if (markdown.length > MARKDOWN_LIMIT) return null;
  const urls = sources.map((source) => source.url);
  const normalizedTopic = normalize(topic);
  const dedupeKey = await sha256(`${normalizedTopic}\n${urls.join("\n")}`);
  const created = now();
  if (!Number.isFinite(created.getTime())) throw new RangeError("now must return a valid date");
  const createdAt = created.toISOString();

  return {
    id: stableUuid(dedupeKey),
    topic,
    markdown,
    sources,
    dedupeKey,
    createdAt,
    expiresAt: new Date(created.getTime() + DRAFT_LIFETIME_MS).toISOString(),
  };
}

function selectedWebSources(usedIds: string[], evidence: KnowledgeEvidence[]): Map<string, KnowledgeDraftSource> | null {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const selected = new Map<string, KnowledgeDraftSource>();
  for (const id of new Set(usedIds)) {
    const item = evidenceById.get(id);
    if (!item) return null;
    if (item.sourceType !== "web") continue;
    const source = sourceFor(item);
    if (!source) return null;
    selected.set(id, source);
  }
  return selected.size ? selected : null;
}

function sourceFor(item: KnowledgeEvidence): KnowledgeDraftSource | null {
  const title = plain(item.title);
  const url = canonicalHttpsUrl(item.url);
  const retrievedAt = timestamp(item.retrievedAt);
  return title && url && retrievedAt ? { title, url, retrievedAt } : null;
}

function webSupportedClaims(claims: GroundedClaim[], sourcesById: Map<string, KnowledgeDraftSource>): GroundedClaim[] {
  return claims.flatMap((claim) => {
    const text = plain(claim.text);
    if (!text || !claim.evidenceIds.some((id) => sourcesById.has(id))) return [];
    return [{ text, evidenceIds: [...claim.evidenceIds] }];
  });
}

function canonicalSources(values: Iterable<KnowledgeDraftSource>): KnowledgeDraftSource[] {
  const byUrl = new Map<string, KnowledgeDraftSource>();
  for (const source of values) {
    const current = byUrl.get(source.url);
    if (!current || sourceOrder(source, current) < 0) byUrl.set(source.url, source);
  }
  return [...byUrl.values()].sort(sourceOrder);
}

function sourceOrder(left: KnowledgeDraftSource, right: KnowledgeDraftSource): number {
  return left.url.localeCompare(right.url) || left.title.localeCompare(right.title) || left.retrievedAt.localeCompare(right.retrievedAt);
}

function topicFor(value: string): string {
  return [...plain(value)].slice(0, TOPIC_LIMIT).join("").trim();
}

function renderMarkdown(topic: string, claims: GroundedClaim[], sources: KnowledgeDraftSource[]): string {
  const keyPoints = claims.map((claim) => `- ${markdownText(claim.text)}`).join("\n");
  const references = sources.map((source) => `- ${markdownText(source.title)}：${markdownText(source.url)}（擷取時間：${source.retrievedAt}）`).join("\n");
  return `# ${markdownText(topic)}\n\n> 本草稿僅根據已驗證的網頁來源整理，待管理員審核後才會發布。\n\n## 重點整理\n\n${keyPoints}\n\n## 使用提醒\n\n內容僅供一般跑步資訊參考，請依個人狀況調整；若有疼痛、受傷或其他健康疑慮，請諮詢醫療專業人員。\n\n## 來源\n\n${references}\n`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableUuid(hash: string): string {
  const bytes = hash.slice(0, 32).match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    url.hash = "";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
  } catch {
    return null;
  }
}

function timestamp(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function plain(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function markdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/[`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
