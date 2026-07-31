import { afterEach, describe, expect, it, vi } from "vitest";

import { AnswerUnavailableError, WorkersAiAnswerService } from "../src/answers/openrouter";

describe("WorkersAiAnswerService", () => {
  afterEach(() => vi.useRealTimers());

  it("posts the bounded chat request and parses response and usage", async () => {
    const ai = {
      run: vi.fn(async (_model: string, _input: unknown, _options?: unknown) =>
        ({
          response: "  可以，先把配速放慢。  ",
          usage: { prompt_tokens: 123, completion_tokens: 45 },
        }),
      ),
    };

    const service = new WorkersAiAnswerService(ai as never);
    await expect(service.answer({ question: "今天膝蓋痛怎麼辦？", locale: "zh-TW" })).resolves.toEqual({
      text: "可以，先把配速放慢。",
      model: "@cf/meta/llama-3.2-3b-instruct",
      inputTokens: 123,
      outputTokens: 45,
    });

    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input, options] = ai.run.mock.calls[0]!;
    expect(model).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(input).toEqual({
      messages: [
        { role: "system", content: expect.any(String) },
        { role: "user", content: "今天膝蓋痛怎麼辦？" },
      ],
      temperature: 0.3,
      max_tokens: 700,
    });
    expect(options).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("returns null token counts when usage is absent", async () => {
    const ai = {
      run: vi.fn(async () => ({ response: "先休息兩天" })),
    };

    await expect(
      new WorkersAiAnswerService(ai as never).answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).resolves.toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it("rejects empty response content as a provider error", async () => {
    const ai = {
      run: vi.fn(async () => ({ response: "   " })),
    };

    await expect(
      new WorkersAiAnswerService(ai as never).answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).rejects.toEqual(new AnswerUnavailableError("provider_error"));
  });

  it.each([
    [429, "rate_limited"],
    [500, "provider_error"],
    [503, "provider_error"],
  ] as const)("maps thrown HTTP %i to %s", async (status, reason) => {
    const ai = {
      run: vi.fn(async () => {
        throw Object.assign(new Error("bad"), { status });
      }),
    };

    await expect(
      new WorkersAiAnswerService(ai as never).answer({ question: "q", locale: "zh-TW" }),
    ).rejects.toEqual(new AnswerUnavailableError(reason));
  });

  it("falls back to the secondary model when the primary model is rate limited", async () => {
    let now = 0;
    const observations: unknown[] = [];
    const ai = {
      run: vi
        .fn()
        .mockImplementationOnce(async () => {
          now = 10;
          throw Object.assign(new Error("rate limited"), { status: 429 });
        })
        .mockImplementationOnce(async () => {
          now = 30;
          return { response: "  fallback answer  " };
        }),
    };

    await expect(
      new WorkersAiAnswerService(
        ai as never,
        "@cf/meta/llama-3.2-3b-instruct",
        "@cf/meta/llama-3.2-1b-instruct",
        () => now,
      ).answer(
        {
          question: "question",
          locale: "zh-TW",
        },
        (event) => observations.push(event),
      ),
    ).resolves.toEqual({
      text: "fallback answer",
      model: "@cf/meta/llama-3.2-1b-instruct",
      inputTokens: null,
      outputTokens: null,
    });

    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(ai.run.mock.calls[0]![0]).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(ai.run.mock.calls[1]![0]).toBe("@cf/meta/llama-3.2-1b-instruct");
    expect(observations).toEqual([
      {
        type: "attempt.started",
        provider: "workers_ai",
        role: "primary",
        model: "@cf/meta/llama-3.2-3b-instruct",
      },
      {
        type: "attempt.failed",
        provider: "workers_ai",
        role: "primary",
        model: "@cf/meta/llama-3.2-3b-instruct",
        reason: "rate_limited",
        durationMs: 10,
      },
      {
        type: "fallback.started",
        provider: "workers_ai",
        role: "fallback",
        model: "@cf/meta/llama-3.2-1b-instruct",
        reason: "rate_limited",
      },
      {
        type: "attempt.started",
        provider: "workers_ai",
        role: "fallback",
        model: "@cf/meta/llama-3.2-1b-instruct",
      },
      {
        type: "attempt.completed",
        provider: "workers_ai",
        role: "fallback",
        model: "@cf/meta/llama-3.2-1b-instruct",
        durationMs: 20,
      },
    ]);
  });

  it("preserves provider behavior when the safe observer throws", async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({ response: "safe answer" }),
    };
    const service = new WorkersAiAnswerService(ai as never);

    await expect(
      service.answer(
        { question: "question", locale: "zh-TW" },
        () => {
          throw new Error("observer unavailable");
        },
      ),
    ).resolves.toMatchObject({
      text: "safe answer",
      model: "@cf/meta/llama-3.2-3b-instruct",
    });
  });

  it("falls back to the secondary model when the primary model returns provider_error", async () => {
    const ai = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error("bad"))
        .mockResolvedValueOnce({ response: "fallback answer" }),
    };

    await expect(
      new WorkersAiAnswerService(ai as never, "@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.2-1b-instruct").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).resolves.toEqual({
      text: "fallback answer",
      model: "@cf/meta/llama-3.2-1b-instruct",
      inputTokens: null,
      outputTokens: null,
    });

    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("falls back to the secondary model when the primary model times out", async () => {
    vi.useFakeTimers();
    const ai = {
      run: vi
        .fn()
        .mockImplementationOnce((_model: string, _input: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
        )
        .mockResolvedValueOnce({ response: "fallback answer" }),
    };

    const answer = new WorkersAiAnswerService(ai as never, "@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.2-1b-instruct").answer({
      question: "question",
      locale: "zh-TW",
    });

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(answer).resolves.toEqual({
      text: "fallback answer",
      model: "@cf/meta/llama-3.2-1b-instruct",
      inputTokens: null,
      outputTokens: null,
    });

    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("reports provider_error when both primary and fallback models fail", async () => {
    const ai = {
      run: vi.fn().mockRejectedValue(new Error("bad")),
    };

    await expect(
      new WorkersAiAnswerService(ai as never, "@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.2-1b-instruct").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).rejects.toEqual(new AnswerUnavailableError("provider_error"));

    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("preserves a fallback timeout as the terminal reason when neither attempt was rate limited", async () => {
    vi.useFakeTimers();
    const ai = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error("primary provider failed"))
        .mockImplementationOnce((_model: string, _input: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
        ),
    };

    const answer = new WorkersAiAnswerService(
      ai as never,
      "@cf/meta/llama-3.2-3b-instruct",
      "@cf/meta/llama-3.2-1b-instruct",
    ).answer({
      question: "question",
      locale: "zh-TW",
    });
    const rejection = expect(answer).rejects.toEqual(
      new AnswerUnavailableError("timeout"),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("keeps rate limiting ahead of a fallback timeout", async () => {
    const ai = {
      run: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
        .mockRejectedValueOnce(new AnswerUnavailableError("timeout")),
    };

    await expect(
      new WorkersAiAnswerService(
        ai as never,
        "@cf/meta/llama-3.2-3b-instruct",
        "@cf/meta/llama-3.2-1b-instruct",
      ).answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).rejects.toEqual(new AnswerUnavailableError("rate_limited"));
  });

});
