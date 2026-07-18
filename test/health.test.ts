import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("GET /health", () => {
  it("returns a non-secret readiness response", async () => {
    const response = await worker.fetch(new Request("https://bot.test/health"), {} as never, {} as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
