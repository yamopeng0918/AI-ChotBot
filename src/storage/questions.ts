export type FinalStatus = "answered" | "provider_unavailable" | "reply_failed";
export interface QuestionRecord { webhookEventId: string; userKey: string | null; question: string; answer: string; status: FinalStatus; model: string | null; createdAt: string; expiresAt: string; }
type Prepared = { text: string; model: string | null; status: "answered" | "provider_unavailable" };
export type ClaimResult =
  | { state: "claimed"; leaseToken: string; leaseUntil: string; createdAt: string; expiresAt: string; prepared?: Prepared }
  | { state: "completed" }
  | { state: "busy"; leaseUntil: string };
export class StaleClaimError extends Error { constructor() { super("Question processing lease is stale"); this.name = "StaleClaimError"; } }

type StoredRow = { status: string; lease_until: string; lease_token: string; answer: string | null; model: string | null; prepared_status: string | null; created_at: string; expires_at: string };
export class QuestionsRepository {
  constructor(private db: D1Database, private now: () => string = () => new Date().toISOString(), private token: () => string = () => crypto.randomUUID()) {}
  async claim(webhookEventId: string, leaseUntil: string, receivedAt: string): Promise<ClaimResult> {
    const now = this.now(), leaseToken = this.token(), expiresAt = new Date(Date.parse(receivedAt) + 30 * 86_400_000).toISOString();
    const result = await this.db.prepare(`INSERT INTO questions (webhook_event_id,status,lease_until,lease_token,created_at,updated_at,expires_at)
      VALUES (?1,'processing',?2,?3,?4,?5,?6) ON CONFLICT(webhook_event_id) DO UPDATE SET status='processing',lease_until=?2,lease_token=?3,updated_at=?5
      WHERE questions.status='reply_failed' OR (questions.status='processing' AND questions.lease_until<=?5)`).bind(webhookEventId, leaseUntil, leaseToken, receivedAt, now, expiresAt).run();
    const row = await this.db.prepare("SELECT status,lease_until,lease_token,answer,model,prepared_status,created_at,expires_at FROM questions WHERE webhook_event_id=?1").bind(webhookEventId).first<StoredRow>();
    if (!row) throw new Error("Claim row missing");
    if ((result.meta.changes ?? 0) === 1) return { state: "claimed", leaseToken, leaseUntil: row.lease_until, createdAt: row.created_at, expiresAt: row.expires_at, ...(row.answer && row.prepared_status ? { prepared: { text: row.answer, model: row.model, status: row.prepared_status as Prepared["status"] } } : {}) };
    if (row.status === "answered" || row.status === "provider_unavailable") return { state: "completed" };
    return { state: "busy", leaseUntil: row.lease_until };
  }
  async prepare(record: QuestionRecord, preparedStatus: Prepared["status"], leaseToken: string): Promise<void> {
    const r = await this.db.prepare("UPDATE questions SET user_key=?2,question=?3,answer=?4,model=?5,prepared_status=?6,updated_at=?7 WHERE webhook_event_id=?1 AND status='processing' AND lease_token=?8").bind(record.webhookEventId, record.userKey, record.question, record.answer, record.model, preparedStatus, this.now(), leaseToken).run(); this.assertChanged(r);
  }
  async complete(record: QuestionRecord, leaseToken: string): Promise<void> {
    const r = await this.db.prepare("UPDATE questions SET user_key=?2,question=?3,answer=?4,status=?5,model=?6,prepared_status=COALESCE(prepared_status,CASE WHEN ?5='reply_failed' THEN NULL ELSE ?5 END),lease_until=NULL,lease_token=NULL,updated_at=?7 WHERE webhook_event_id=?1 AND status='processing' AND lease_token=?8").bind(record.webhookEventId, record.userKey, record.question, record.answer, record.status, record.model, this.now(), leaseToken).run(); this.assertChanged(r);
  }
  async release(webhookEventId: string, leaseToken: string): Promise<void> { const r = await this.db.prepare("DELETE FROM questions WHERE webhook_event_id=?1 AND status='processing' AND lease_token=?2 AND answer IS NULL").bind(webhookEventId, leaseToken).run(); this.assertChanged(r); }
  async purgeExpired(nowIso: string): Promise<number> { const r = await this.db.prepare("DELETE FROM questions WHERE expires_at<=?1").bind(nowIso).run(); return r.meta.changes ?? 0; }
  private assertChanged(result: D1Result) { if ((result.meta.changes ?? 0) !== 1) throw new StaleClaimError(); }
}
export async function pseudonymizeUserId(userId: string | null, analyticsHashKey: string): Promise<string | null> { if (userId === null) return null; const e = new TextEncoder(); const key = await crypto.subtle.importKey("raw", e.encode(analyticsHashKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const signature = await crypto.subtle.sign("HMAC", key, e.encode(userId)); return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
