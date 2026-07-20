import { describe, expect, test, vi } from "vitest";

import { verifyAdminBearer } from "../../src/knowledge/admin-auth";

describe("verifyAdminBearer", () => {
  test.each([
    ["an absent header", undefined],
    ["the wrong scheme", "Basic admin-secret"],
    ["an empty token", "Bearer "],
    ["a wrong token of the same length", "Bearer admin-secrex"],
    ["a wrong token of a different length", "Bearer no"],
  ])("rejects %s", async (_case, header) => {
    await expect(verifyAdminBearer(header, "admin-secret")).resolves.toBe(false);
  });

  test("accepts the exact token", async () => {
    await expect(verifyAdminBearer("Bearer admin-secret", "admin-secret")).resolves.toBe(true);
  });

  test.each(["admin-secrex", "no", "admin-secret"])(
    "digests both complete non-empty tokens before comparing %s",
    async (token) => {
      const digest = vi.spyOn(crypto.subtle, "digest");

      await verifyAdminBearer(`Bearer ${token}`, "admin-secret");

      expect(digest).toHaveBeenCalledTimes(2);
      expect(digest.mock.calls.map(([, bytes]) => new Uint8Array(bytes as ArrayBuffer))).toEqual([
        new TextEncoder().encode(token),
        new TextEncoder().encode("admin-secret"),
      ]);
      digest.mockRestore();
    },
  );
});
