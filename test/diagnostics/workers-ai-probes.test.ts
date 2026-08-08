import { describe, expect, it, vi } from "vitest";

import { WORKERS_AI_GROUNDED_RESPONSE_FORMAT } from "../../src/answers/grounded-generators";
import { runWorkersAiProbes } from "../../src/diagnostics/workers-ai-probes";

describe("runWorkersAiProbes", () => {
  it("runs three fixed probes sequentially and discards provider output", async () => {
    const order: number[] = [];
    const ai = {
      run: vi.fn(async (_model: string, _input: unknown) => {
        order.push(order.length + 1);
        return { response: `secret-output-${order.length}` };
      }),
    };

    await expect(runWorkersAiProbes(ai)).resolves.toEqual({ probes: [
      { name: "baseline", outcome: "success" },
      { name: "simple_json", outcome: "success" },
      { name: "grounded_schema", outcome: "success" },
    ] });
    expect(order).toEqual([1, 2, 3]);
    expect(ai.run).toHaveBeenCalledTimes(3);
    expect(ai.run.mock.calls[0]![1]).not.toHaveProperty("response_format");
    expect(ai.run.mock.calls[1]![1]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string", enum: ["ok"] } },
        },
      },
    });
    expect(ai.run.mock.calls[2]![1]).toMatchObject({
      response_format: WORKERS_AI_GROUNDED_RESPONSE_FORMAT,
    });
    expect(JSON.stringify(await runWorkersAiProbes({ run: vi.fn().mockResolvedValue({ response: "secret" }) })))
      .not.toContain("secret");
  });

  it("reduces failures to closed categories and continues all probes", async () => {
    const ai = {
      run: vi.fn()
        .mockRejectedValueOnce("No more data centers to forward the request: secret-capacity")
        .mockRejectedValueOnce(new Error("JSON Mode couldn't be met: secret-json"))
        .mockRejectedValueOnce(new Error("secret-unknown")),
    };

    const result = await runWorkersAiProbes(ai);

    expect(result).toEqual({ probes: [
      { name: "baseline", outcome: "failed", diagnosticCategory: "capacity" },
      { name: "simple_json", outcome: "failed", diagnosticCategory: "json_mode_unmet" },
      { name: "grounded_schema", outcome: "failed", diagnosticCategory: "unknown" },
    ] });
    expect(ai.run).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toMatch(/secret-capacity|secret-json|secret-unknown|message|stack|error/);
  });
});
