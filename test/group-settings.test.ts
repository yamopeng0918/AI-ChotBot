import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import migrationSql from "../migrations/0004_group_settings_weather_cache.sql?raw";
import { GroupSettingsRepository } from "../src/storage/group-settings";

let mf: Miniflare;
let db: D1Database;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {}",
    compatibilityDate: "2026-07-17",
    d1Databases: { DB: "group-settings" },
  });
  db = (await mf.getD1Database("DB")) as D1Database;
  await db.exec(migrationSql.replace(/\r?\n/g, " "));
});

afterEach(async () => {
  await mf.dispose();
});

describe("GroupSettingsRepository", () => {
  it("stores and clears per-group default weather cities", async () => {
    const repo = new GroupSettingsRepository(db, () => "2026-07-25T00:00:00.000Z");

    expect(await repo.getWeatherCity("group-1")).toBeNull();
    await repo.setWeatherCity("group-1", "台北");
    expect(await repo.getWeatherCity("group-1")).toBe("台北");
    expect(await repo.clearWeatherCity("group-1")).toBe(true);
    expect(await repo.getWeatherCity("group-1")).toBeNull();
  });
});
