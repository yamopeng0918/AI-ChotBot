import { afterEach, describe, expect, it, vi } from "vitest";

import { AnswerUnavailableError, OpenRouterAnswerService } from "../src/answers/openrouter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouterAnswerService", () => {
  afterEach(() => vi.useRealTimers());

  it("posts the bounded chat request and parses content and usage", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        model: "provider/model-version",
        choices: [{ message: { content: "  建議先慢跑。  " } }],
        usage: { prompt_tokens: 123, completion_tokens: 45 },
      }),
    );
    const service = new OpenRouterAnswerService(fetcher, "secret-key", "configured/model");

    await expect(service.answer({ question: "今天怎麼跑？", locale: "zh-TW" })).resolves.toEqual({
      text: "建議先慢跑。",
      model: "provider/model-version",
      inputTokens: 123,
      outputTokens: 45,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer secret-key",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: "configured/model",
      messages: [
        { role: "system", content: expect.any(String) },
        { role: "user", content: "今天怎麼跑？" },
      ],
      temperature: 0.3,
      max_tokens: 700,
    });
  });

  it("returns null token counts when usage is absent", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ model: "configured/model", choices: [{ message: { content: "回答" } }] }),
    );

    await expect(
      new OpenRouterAnswerService(fetcher, "key", "configured/model").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).resolves.toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it("rejects empty response content as a provider error", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ model: "configured/model", choices: [{ message: { content: "   " } }] }),
    );

    await expect(
      new OpenRouterAnswerService(fetcher, "key", "configured/model").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).rejects.toEqual(new AnswerUnavailableError("provider_error"));
  });

  it.each([
    [429, "rate_limited"],
    [500, "provider_error"],
    [503, "provider_error"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "not exposed" }, status));

    await expect(
      new OpenRouterAnswerService(fetcher, "key", "model").answer({ question: "q", locale: "zh-TW" }),
    ).rejects.toEqual(new AnswerUnavailableError(reason));
  });

  it("falls back to the secondary model when the primary model is rate limited", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        jsonResponse({
          model: "fallback/model",
          choices: [{ message: { content: "  fallback answer  " } }],
        }),
      );

    await expect(
      new OpenRouterAnswerService(fetcher, "key", "primary/model", "fallback/model").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).resolves.toEqual({
      text: "fallback answer",
      model: "fallback/model",
      inputTokens: null,
      outputTokens: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [primaryUrl, primaryInit] = fetcher.mock.calls[0]!;
    expect(primaryUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(primaryInit?.body))).toMatchObject({ model: "primary/model" });
    const [, fallbackInit] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(fallbackInit?.body))).toMatchObject({ model: "fallback/model" });
  });

  it("falls back to the secondary model when the primary model returns provider_error", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          model: "fallback/model",
          choices: [{ message: { content: "  fallback answer  " } }],
        }),
      );

    await expect(
      new OpenRouterAnswerService(fetcher, "key", "primary/model", "fallback/model").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).resolves.toEqual({
      text: "fallback answer",
      model: "fallback/model",
      inputTokens: null,
      outputTokens: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to the secondary model when the primary model times out", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementationOnce((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model: "fallback/model",
          choices: [{ message: { content: "  fallback answer  " } }],
        }),
      );

    const answer = new OpenRouterAnswerService(fetcher, "key", "primary/model", "fallback/model").answer({
      question: "question",
      locale: "zh-TW",
    });

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(answer).resolves.toEqual({
      text: "fallback answer",
      model: "fallback/model",
      inputTokens: null,
      outputTokens: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, fallbackInit] = fetcher.mock.calls[1]!;
    const fallbackBody = JSON.parse(String(fallbackInit?.body));
    expect(fallbackBody.model).toBe("fallback/model");
  });

  it("reports provider_error when both primary and fallback models fail", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(new Response("bad", { status: 503 }));

    await expect(
      new OpenRouterAnswerService(fetcher, "key", "primary/model", "fallback/model").answer({
        question: "question",
        locale: "zh-TW",
      }),
    ).rejects.toEqual(new AnswerUnavailableError("provider_error"));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts after 20 seconds and reports a timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    );
    const answer = new OpenRouterAnswerService(fetcher, "key", "model").answer({
      question: "q",
      locale: "zh-TW",
    });
    const rejection = expect(answer).rejects.toEqual(new AnswerUnavailableError("timeout"));

    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
  });
});
