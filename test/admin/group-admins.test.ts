import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import migrationSql from "../../migrations/0002_group_admins.sql?raw";
import { GroupAdminsRepository, type GroupAdminSeed } from "../../src/admin/group-admins";

let mf: Miniflare;
let db: D1Database;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {}",
    compatibilityDate: "2026-07-17",
    d1Databases: { DB: "group-admins" },
  });
  db = (await mf.getD1Database("DB")) as D1Database;
  await db.exec(migrationSql.replace(/\r?\n/g, " "));
});

afterEach(async () => {
  await mf.dispose();
});

const seed: GroupAdminSeed = { userId: "U1", displayName: "Alice" };

describe("GroupAdminsRepository with real Miniflare D1", () => {
  it("parses the bootstrap JSON into per-group seed lists", () => {
    const repo = new GroupAdminsRepository({} as never);

    expect(repo.parseBootstrap(`{"group-1":[{"userId":"U1","displayName":"Alice"}]}`)).toEqual({
      "group-1": [{ userId: "U1", displayName: "Alice" }],
    });
  });

  it("inserts the first bootstrap seed once and keeps stable list order", async () => {
    const repo = new GroupAdminsRepository(db, () => "2026-07-24T00:00:00.000Z");

    await repo.ensureBootstrap("group-1", [
      { userId: "U2", displayName: "Bob" },
      { userId: "U1", displayName: "Alice" },
    ], "bootstrap");

    expect(await repo.list("group-1")).toEqual([
      {
        groupId: "group-1",
        userId: "U1",
        displayName: "Alice",
        source: "bootstrap",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      {
        groupId: "group-1",
        userId: "U2",
        displayName: "Bob",
        source: "bootstrap",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    ]);
  });

  it("does not create duplicates when ensureBootstrap runs twice", async () => {
    const repo = new GroupAdminsRepository(db, () => "2026-07-24T00:00:00.000Z");

    await repo.ensureBootstrap("group-1", [seed], "env");
    await repo.ensureBootstrap("group-1", [seed], "env");

    expect(await repo.list("group-1")).toHaveLength(1);
  });

  it("does not seed a group from bootstrap once any runtime row already exists", async () => {
    const repo = new GroupAdminsRepository(db, () => "2026-07-24T00:00:00.000Z");

    await repo.upsert("group-1", { userId: "U-runtime", displayName: "Runtime" }, "command");
    await repo.ensureBootstrap(
      "group-1",
      [
        { userId: "U1", displayName: "Alice" },
        { userId: "U2", displayName: "Bob" },
      ],
      "env"
    );

    expect(await repo.list("group-1")).toEqual([
      {
        groupId: "group-1",
        userId: "U-runtime",
        displayName: "Runtime",
        source: "command",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    ]);
  });

  it("updates displayName and updatedAt for an existing admin", async () => {
    const repo = new GroupAdminsRepository(db, () => "2026-07-24T00:00:00.000Z");

    await repo.upsert("group-1", seed, "command");

    const later = new GroupAdminsRepository(db, () => "2026-07-24T01:00:00.000Z");
    await later.upsert("group-1", { userId: "U1", displayName: "Alice Updated" }, "command");

    expect(await repo.list("group-1")).toEqual([
      {
        groupId: "group-1",
        userId: "U1",
        displayName: "Alice Updated",
        source: "command",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T01:00:00.000Z",
      },
    ]);
  });

  it("returns true from remove only when a row existed", async () => {
    const repo = new GroupAdminsRepository(db);

    await repo.upsert("group-1", seed, "command");

    expect(await repo.remove("group-1", "U1")).toBe(true);
    expect(await repo.remove("group-1", "U1")).toBe(false);
  });

  it("returns false for null and unknown users", async () => {
    const repo = new GroupAdminsRepository(db);

    await repo.upsert("group-1", seed, "command");

    expect(await repo.isAdmin("group-1", null)).toBe(false);
    expect(await repo.isAdmin("group-1", "missing")).toBe(false);
  });
});
