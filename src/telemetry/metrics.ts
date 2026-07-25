export type MetricIntent = "general" | "weather";
export type MetricStatus = "answered" | "provider_unavailable" | "reply_failed";

export interface MetricRecord {
  webhookEventId: string;
  intent: MetricIntent;
  status: MetricStatus;
  model: string | null;
  durationMs: number;
  detail: string | null;
  createdAt: string;
}

export interface MetricsSink {
  record(metric: MetricRecord): Promise<void>;
}

export class D1MetricsRepository implements MetricsSink {
  constructor(private readonly db: D1Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async record(metric: MetricRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO metrics (webhook_event_id,intent,status,model,duration_ms,detail,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
      )
      .bind(metric.webhookEventId, metric.intent, metric.status, metric.model, metric.durationMs, metric.detail, metric.createdAt ?? this.now())
      .run();
  }
}

export const noopMetrics: MetricsSink = {
  async record() {},
};
