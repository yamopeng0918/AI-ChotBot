import { describe, expect, it, vi } from "vitest";
import {
  FallbackGroundedGenerator,
  type GroundedProviderEvent,
  OpenRouterGroundedGenerator,
} from "../../src/answers/grounded-generators";

describe("OpenRouterGroundedGenerator", () => {
  it("requests strict JSON from the configured model", async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({
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

describe("FallbackGroundedGenerator", () => {
  it("uses the fallback generator after the primary fails", async () => {
    const primary = { generate: vi.fn().mockRejectedValue(new Error("primary failed")) };
    const fallback = { generate: vi.fn().mockResolvedValue({ text: "valid", model: "fallback/model" }) };
    const events: GroundedProviderEvent[] = [];
    const chain = new FallbackGroundedGenerator([
      { provider: "openrouter", role: "primary", model: "primary/model", generator: primary },
      { provider: "openrouter", role: "fallback", model: "fallback/model", generator: fallback },
    ], (event) => events.push(event));

    await expect(chain.generate([{ role: "user", content: "q" }]))
      .resolves.toEqual({ text: "valid", model: "fallback/model" });
    expect(primary.generate).toHaveBeenCalledOnce();
    expect(fallback.generate).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "attempt.started", "attempt.failed", "fallback.started", "attempt.started", "attempt.completed",
    ]);
  });

  it("does not call later generators after primary success", async () => {
    const primary = { generate: vi.fn().mockResolvedValue({ text: "valid", model: "primary/model" }) };
    const fallback = { generate: vi.fn() };
    const chain = new FallbackGroundedGenerator([
      { provider: "openrouter", role: "primary", model: "primary/model", generator: primary },
      { provider: "openrouter", role: "fallback", model: "fallback/model", generator: fallback },
    ]);

    await chain.generate([{ role: "user", content: "q" }]);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it.each([400, 401, 402, 403, 404, 429, 500, 503])(
    "uses the next generator after OpenRouter returns %i",
    async (status) => {
      const primary = new OpenRouterGroundedGenerator(
        async () => new Response("provider failed", { status }),
        "key",
        "primary/model",
      );
      const fallback = { generate: vi.fn().mockResolvedValue({ text: "valid", model: "fallback/model" }) };
      const events: GroundedProviderEvent[] = [];
      const chain = new FallbackGroundedGenerator([
        { provider: "openrouter", role: "primary", model: "primary/model", generator: primary },
        { provider: "openrouter", role: "fallback", model: "fallback/model", generator: fallback },
      ], (event) => events.push(event));

      await expect(chain.generate([{ role: "user", content: "q" }]))
        .resolves.toEqual({ text: "valid", model: "fallback/model" });
      expect(events.find((event) => event.type === "attempt.failed")).toMatchObject({
        reason: "http",
        status,
      });
    },
  );

  it("uses the next generator after an OpenRouter fetch timeout", async () => {
    vi.useFakeTimers();
    try {
      const primary = new OpenRouterGroundedGenerator(
        async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
        "key",
        "primary/model",
      );
      const fallback = { generate: vi.fn().mockResolvedValue({ text: "valid", model: "fallback/model" }) };
      const events: GroundedProviderEvent[] = [];
      const chain = new FallbackGroundedGenerator([
        { provider: "openrouter", role: "primary", model: "primary/model", generator: primary },
        { provider: "openrouter", role: "fallback", model: "fallback/model", generator: fallback },
      ], (event) => events.push(event));

      const generation = chain.generate([{ role: "user", content: "q" }]);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(generation).resolves.toEqual({ text: "valid", model: "fallback/model" });
      expect(events.find((event) => event.type === "attempt.failed")).toMatchObject({ reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
