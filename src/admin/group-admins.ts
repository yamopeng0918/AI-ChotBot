export type GroupAdminSeed = { userId: string; displayName: string };
export type GroupAdminRecord = {
  groupId: string;
  userId: string;
  displayName: string;
  source: "env" | "bootstrap" | "command";
  createdAt: string;
  updatedAt: string;
};

type GroupAdminRow = {
  group_id: string;
  user_id: string;
  display_name: string;
  source: GroupAdminRecord["source"];
  created_at: string;
  updated_at: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSeed = (value: unknown): value is GroupAdminSeed =>
  isObject(value) && typeof value.userId === "string" && typeof value.displayName === "string";

export class GroupAdminsRepository {
  constructor(private db: D1Database, private now: () => string = () => new Date().toISOString()) {}

  parseBootstrap(raw: string | undefined): Record<string, GroupAdminSeed[]> {
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) return {};

      const result: Record<string, GroupAdminSeed[]> = {};
      for (const [groupId, seeds] of Object.entries(parsed)) {
        if (!Array.isArray(seeds)) continue;
        const validSeeds = seeds.filter(isSeed).map((seed) => ({ userId: seed.userId, displayName: seed.displayName }));
        if (validSeeds.length > 0) result[groupId] = validSeeds;
      }
      return result;
    } catch {
      return {};
    }
  }

  async ensureBootstrap(groupId: string, seeds: GroupAdminSeed[], source: "env" | "bootstrap"): Promise<void> {
    const timestamp = this.now();
    for (const seed of seeds) {
      await this.db.prepare(
        "INSERT OR IGNORE INTO group_admins (group_id, user_id, display_name, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
      ).bind(groupId, seed.userId, seed.displayName, source, timestamp, timestamp).run();
    }
  }

  async list(groupId: string): Promise<GroupAdminRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT group_id, user_id, display_name, source, created_at, updated_at FROM group_admins WHERE group_id = ?1 ORDER BY created_at, user_id"
      )
      .bind(groupId)
      .all<GroupAdminRow>();
    return (rows.results ?? []).map((row) => ({
      groupId: row.group_id,
      userId: row.user_id,
      displayName: row.display_name,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async isAdmin(groupId: string, userId: string | null): Promise<boolean> {
    if (userId === null) return false;
    const row = await this.db
      .prepare("SELECT 1 AS found FROM group_admins WHERE group_id = ?1 AND user_id = ?2 LIMIT 1")
      .bind(groupId, userId)
      .first<{ found: number }>();
    return row !== null;
  }

  async upsert(groupId: string, seed: GroupAdminSeed, source: "env" | "bootstrap" | "command"): Promise<void> {
    const timestamp = this.now();
    await this.db.prepare(
      "INSERT INTO group_admins (group_id, user_id, display_name, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(group_id, user_id) DO UPDATE SET display_name = excluded.display_name, source = excluded.source, updated_at = excluded.updated_at"
    ).bind(groupId, seed.userId, seed.displayName, source, timestamp, timestamp).run();
  }

  async remove(groupId: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM group_admins WHERE group_id = ?1 AND user_id = ?2").bind(groupId, userId).run();
    return (result.meta.changes ?? 0) > 0;
  }
}
