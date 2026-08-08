export type KnowledgeDraftStatus = "pending" | "approved" | "rejected";

export type KnowledgeDraftSource = {
  title: string;
  url: string;
  retrievedAt: string;
};

export type KnowledgeDraft = {
  id: string;
  status: KnowledgeDraftStatus;
  topic: string;
  markdown: string;
  sources: KnowledgeDraftSource[];
  dedupeKey: string;
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  reviewedAt: string | null;
};

export type CreateKnowledgeDraftInput = {
  id: string;
  topic: string;
  markdown: string;
  sources: KnowledgeDraftSource[];
  dedupeKey: string;
  createdAt: string;
  expiresAt: string;
};

type KnowledgeDraftRow = {
  id: unknown;
  status: unknown;
  topic: unknown;
  markdown: unknown;
  sources_json: unknown;
  dedupe_key: unknown;
  document_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  expires_at: unknown;
  reviewed_at: unknown;
};

export class KnowledgeDraftRepository {
  constructor(private readonly db: D1Database) {}

  async createOrRefresh(input: CreateKnowledgeDraftInput): Promise<KnowledgeDraft> {
    const draft = validateCreateInput(input);
    await this.db.prepare(`INSERT INTO knowledge_drafts
      (id,status,topic,markdown,sources_json,dedupe_key,document_id,created_at,updated_at,expires_at,reviewed_at)
      VALUES (?, 'pending', ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        topic=excluded.topic, markdown=excluded.markdown, sources_json=excluded.sources_json,
        updated_at=excluded.updated_at, expires_at=excluded.expires_at
      WHERE knowledge_drafts.status='pending'`).bind(
      draft.id, draft.topic, draft.markdown, JSON.stringify(draft.sources), draft.dedupeKey,
      draft.createdAt, draft.createdAt, draft.expiresAt,
    ).run();
    const row = await this.findByDedupeKey(draft.dedupeKey);
    if (!row) throw new Error("knowledge draft disappeared");
    return row;
  }

  async list(status: KnowledgeDraftStatus, limit: number): Promise<KnowledgeDraft[]> {
    const boundedLimit = clampLimit(limit);
    const result = await this.db.prepare(`SELECT * FROM knowledge_drafts
      WHERE status=? ORDER BY updated_at DESC, id DESC LIMIT ?`).bind(status, boundedLimit).all<KnowledgeDraftRow>();
    return result.results.map(decodeDraftRow);
  }

  async get(id: string): Promise<KnowledgeDraft | null> {
    const row = await this.db.prepare("SELECT * FROM knowledge_drafts WHERE id=?").bind(id).first<KnowledgeDraftRow>();
    return row ? decodeDraftRow(row) : null;
  }

  async approve(id: string, documentId: string, now: string): Promise<"approved" | "conflict" | "not_found"> {
    const reviewedAt = normalizeTimestamp(now, "now");
    if (!isNonEmptyString(documentId)) throw new RangeError("documentId must be a non-empty string");
    const result = await this.db.prepare(`UPDATE knowledge_drafts
      SET status='approved', document_id=?, reviewed_at=?, updated_at=?
      WHERE id=? AND status='pending'`).bind(documentId, reviewedAt, reviewedAt, id).run();
    if (result.meta.changes === 1) return "approved";
    const draft = await this.get(id);
    if (!draft) return "not_found";
    return draft.status === "approved" && draft.documentId === documentId ? "approved" : "conflict";
  }

  async reject(id: string, now: string): Promise<"rejected" | "conflict" | "not_found"> {
    const reviewedAt = normalizeTimestamp(now, "now");
    const expiresAt = thirtyDaysAfter(reviewedAt);
    const result = await this.db.prepare(`UPDATE knowledge_drafts
      SET status='rejected', reviewed_at=?, updated_at=?, expires_at=?
      WHERE id=? AND status='pending'`).bind(reviewedAt, reviewedAt, expiresAt, id).run();
    if (result.meta.changes === 1) return "rejected";
    const draft = await this.get(id);
    if (!draft) return "not_found";
    return draft.status === "rejected" ? "rejected" : "conflict";
  }

  async purgeExpired(now: string): Promise<void> {
    const reviewedAt = normalizeTimestamp(now, "now");
    const rejectedExpiry = thirtyDaysAfter(reviewedAt);
    await this.db.batch([
      this.db.prepare(`UPDATE knowledge_drafts
        SET status='rejected', reviewed_at=?, updated_at=?, expires_at=?
        WHERE status='pending' AND expires_at<=?`).bind(reviewedAt, reviewedAt, rejectedExpiry, reviewedAt),
      this.db.prepare("DELETE FROM knowledge_drafts WHERE status='rejected' AND expires_at<=?").bind(reviewedAt),
      this.db.prepare(`DELETE FROM knowledge_drafts WHERE status='approved'
        AND NOT EXISTS (SELECT 1 FROM knowledge_documents WHERE id=knowledge_drafts.document_id)`),
    ]);
  }

  private async findByDedupeKey(dedupeKey: string): Promise<KnowledgeDraft | null> {
    const row = await this.db.prepare("SELECT * FROM knowledge_drafts WHERE dedupe_key=?").bind(dedupeKey).first<KnowledgeDraftRow>();
    return row ? decodeDraftRow(row) : null;
  }
}

function validateCreateInput(input: CreateKnowledgeDraftInput): CreateKnowledgeDraftInput {
  if (!isNonEmptyString(input.id) || !isNonEmptyString(input.dedupeKey)) throw new RangeError("knowledge draft identifiers must be non-empty strings");
  if (!isNonEmptyString(input.topic) || [...input.topic].length > 120) throw new RangeError("topic must contain 1 to 120 code points");
  if (!isNonEmptyString(input.markdown) || input.markdown.length > 65_536) throw new RangeError("markdown must contain 1 to 65536 code units");
  if (!Array.isArray(input.sources)) throw new TypeError("sources must be an array");
  if (input.sources.length === 0) throw new RangeError("sources must not be empty");
  const sources = input.sources.map(decodeSource);
  return {
    ...input,
    sources,
    createdAt: normalizeTimestamp(input.createdAt, "createdAt"),
    expiresAt: normalizeTimestamp(input.expiresAt, "expiresAt"),
  };
}

function decodeDraftRow(row: KnowledgeDraftRow): KnowledgeDraft {
  if (!isNonEmptyString(row.id) || !isDraftStatus(row.status) || !isNonEmptyString(row.topic) || [...row.topic].length > 120 ||
    !isNonEmptyString(row.markdown) || row.markdown.length > 65_536 || !isNonEmptyString(row.dedupe_key)) throw invalidRow();
  if (!(row.document_id === null || isNonEmptyString(row.document_id)) || !(row.reviewed_at === null || isNonEmptyString(row.reviewed_at))) throw invalidRow();
  const createdAt = decodeTimestamp(row.created_at);
  const updatedAt = decodeTimestamp(row.updated_at);
  const expiresAt = decodeTimestamp(row.expires_at);
  const reviewedAt = row.reviewed_at === null ? null : decodeTimestamp(row.reviewed_at);
  if ((row.status === "approved" && (!row.document_id || !reviewedAt)) || (row.status === "rejected" && !reviewedAt)) throw invalidRow();
  if (typeof row.sources_json !== "string") throw invalidRow();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.sources_json);
  } catch {
    throw invalidRow();
  }
  if (!Array.isArray(parsed)) throw invalidRow();
  return {
    id: row.id, status: row.status, topic: row.topic, markdown: row.markdown,
    sources: parsed.map(decodeSource), dedupeKey: row.dedupe_key, documentId: row.document_id,
    createdAt, updatedAt, expiresAt, reviewedAt,
  };
}

function decodeSource(value: unknown): KnowledgeDraftSource {
  if (!isRecord(value) || !isNonEmptyString(value.title) || !isHttpsUrl(value.url) || !isNonEmptyString(value.retrievedAt)) throw invalidRow();
  return { title: value.title, url: value.url, retrievedAt: decodeTimestamp(value.retrievedAt) };
}

function decodeTimestamp(value: unknown): string {
  if (!isNonEmptyString(value)) throw invalidRow();
  return normalizeTimestamp(value, "timestamp", invalidRow);
}

function normalizeTimestamp(value: string, name: string, invalid: () => never = () => { throw new RangeError(`${name} must be a valid date`); }): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return invalid();
  return new Date(milliseconds).toISOString();
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function thirtyDaysAfter(now: string): string {
  return new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isDraftStatus(value: unknown): value is KnowledgeDraftStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}

function invalidRow(): never {
  throw new Error("invalid knowledge draft row");
}
