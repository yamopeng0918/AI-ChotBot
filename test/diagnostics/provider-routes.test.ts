import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/config";
import { createWorker } from "../../src/index";

describe("POST /admin/diagnostics/workers-ai-probes", () => {
  it.each([undefined, "Basic admin-secret", "Bearer wrong"])(
    "rejects unauthorized request without running probes for %s",
    async (authorization) => {
      const runner = { run: vi.fn() };
      const worker = createWorker({ workersAiProbeRunner: runner });
      const response = await worker.fetch(new Request(
        "https://worker.test/admin/diagnostics/workers-ai-probes",
        { method: "POST", headers: authorization ? { authorization } : undefined },
      ), { ADMIN_API_TOKEN: "admin-secret" } as Env, {} as ExecutionContext);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it("returns only the safe authenticated probe report and ignores request body", async () => {
    const report = { probes: [
      { name: "baseline" as const, outcome: "success" as const },
      { name: "simple_json" as const, outcome: "failed" as const, diagnosticCategory: "json_mode_unmet" as const },
      { name: "nested_shape" as const, outcome: "success" as const },
      { name: "closed_required" as const, outcome: "success" as const },
      { name: "nonempty" as const, outcome: "success" as const },
      { name: "grounded_schema" as const, outcome: "failed" as const, diagnosticCategory: "unknown" as const },
    ] };
    const runner = { run: vi.fn().mockResolvedValue(report) };
    const worker = createWorker({ workersAiProbeRunner: runner });
    const response = await worker.fetch(new Request(
      "https://worker.test/admin/diagnostics/workers-ai-probes",
      {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "secret-user-prompt", token: "secret-token" }),
      },
    ), { ADMIN_API_TOKEN: "admin-secret" } as Env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith();
  });

  it("returns a stable error without leaking unexpected runner failures", async () => {
    const runner = { run: vi.fn().mockRejectedValue(new Error("secret-provider-stack")) };
    const worker = createWorker({ workersAiProbeRunner: runner });
    const response = await worker.fetch(new Request(
      "https://worker.test/admin/diagnostics/workers-ai-probes",
      { method: "POST", headers: { authorization: "Bearer admin-secret" } },
    ), { ADMIN_API_TOKEN: "admin-secret" } as Env, {} as ExecutionContext);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
  });
});
