export type FinalStatus = "answered" | "provider_unavailable" | "reply_failed";
export interface QuestionRecord { webhookEventId: string; userKey: string | null; question: string; answer: string; status: FinalStatus; model: string | null; createdAt: string; expiresAt: string; }
export type ClaimResult = { state: "claimed"; prepared?: { text: string; model: string | null; status: Exclude<FinalStatus, "reply_failed"> } } | { state: "completed" } | { state: "busy" };

export class QuestionsRepository {
  constructor(private db: D1Database, private now: () => string = () => new Date().toISOString()) {}
  async claim(webhookEventId: string, leaseUntilIso: string): Promise<ClaimResult> {
    const now = this.now();
    const result = await this.db.prepare(`INSERT INTO questions (webhook_event_id,status,lease_until,created_at,updated_at,expires_at)
      VALUES (?1,'processing',?2,?3,?3,datetime(?3,'+30 days')) ON CONFLICT(webhook_event_id) DO UPDATE SET status='processing',lease_until=?2,updated_at=?3
      WHERE questions.status='reply_failed' OR (questions.status='processing' AND questions.lease_until<=?3)`).bind(webhookEventId, leaseUntilIso, now).run();
    const row = await this.db.prepare("SELECT status, lease_until, answer, model, prepared_status FROM questions WHERE webhook_event_id=?1").bind(webhookEventId).first<{ status: string; answer: string | null; model: string | null; prepared_status: string | null }>();
    if ((result.meta.changes ?? 0) > 0) return { state: "claimed", ...(row?.answer && row.prepared_status ? { prepared: { text: row.answer, model: row.model, status: row.prepared_status as "answered" | "provider_unavailable" } } : {}) };
    if (row?.status === "answered" || row?.status === "provider_unavailable") return { state: "completed" };
    return { state: "busy" };
  }
  async prepare(record: QuestionRecord, preparedStatus: "answered" | "provider_unavailable"): Promise<void> {
    await this.db.prepare(`UPDATE questions SET user_key=?2,question=?3,answer=?4,model=?5,prepared_status=?6,created_at=?7,updated_at=?7,expires_at=?8 WHERE webhook_event_id=?1 AND status='processing'`).bind(record.webhookEventId, record.userKey, record.question, record.answer, record.model, preparedStatus, record.createdAt, record.expiresAt).run();
  }
  async complete(record: QuestionRecord): Promise<void> {
    await this.db.prepare(`UPDATE questions SET user_key=?2,question=?3,answer=?4,status=?5,model=?6,prepared_status=COALESCE(prepared_status,CASE WHEN ?5='reply_failed' THEN NULL ELSE ?5 END),lease_until=NULL,created_at=?7,updated_at=?7,expires_at=?8 WHERE webhook_event_id=?1`).bind(record.webhookEventId, record.userKey, record.question, record.answer, record.status, record.model, record.createdAt, record.expiresAt).run();
  }
  async release(webhookEventId: string): Promise<void> { await this.db.prepare("DELETE FROM questions WHERE webhook_event_id=?1 AND status='processing' AND answer IS NULL").bind(webhookEventId).run(); }
  async purgeExpired(nowIso: string): Promise<number> { const r = await this.db.prepare("DELETE FROM questions WHERE expires_at<=?1").bind(nowIso).run(); return r.meta.changes ?? 0; }
}

export async function pseudonymizeUserId(userId: string | null, analyticsHashKey: string): Promise<string | null> {
  if (userId === null) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(analyticsHashKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(userId));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
