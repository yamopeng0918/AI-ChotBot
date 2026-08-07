import { describe, expect, it, vi } from "vitest";
import { OpenRouterGroundedGenerator } from "../../src/answers/grounded-generators";

describe("OpenRouterGroundedGenerator", () => {
  it("requests strict JSON from the configured model", async () => {
    const fetcher = vi.fn(async () => Response.json({
      model: "actual/model",
      choices: [{ message: { content: "{\"answer\":\"A\",\"claims\":[]}" } }],
    }));
    const result = await new OpenRouterGroundedGenerator(fetcher, "key", "configured/model")
      .generate([{ role: "system", content: "rules" }]);
    expect(result.model).toBe("actual/model");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({
      model: "configured/model",
      response_format: { type: "json_object" },
    });
  });

  it("does not expose a provider response body", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const generator = new OpenRouterGroundedGenerator(
      async () => new Response("secret-provider-body", { status: 500 }),
      "key",
      "configured/model",
    );
    await expect(generator.generate([{ role: "system", content: "rules" }])).rejects.toThrow();
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-provider-body");
    info.mockRestore();
  });
});
