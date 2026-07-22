import { describe, expect, it, vi } from "vitest";
import { TavilySearchError, TavilySearchService } from "../../src/search/tavily";

const json = (body: unknown, status = 200) => Response.json(body, { status });
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("TavilySearchService", () => {
  it("sends only a bounded question and normalizes safe unique evidence", async () => {
    const fetcher = vi.fn<Fetcher>(async () => json({ results: [
      { title: " First ", content: " useful snippet ", url: "https://Example.com/a#part", score: .8, published_date: "2026-07-20" },
      { title: "duplicate", content: "other", url: "https://example.com/a", score: .7 },
      { title: "insecure", content: "no", url: "http://example.com/no", score: .9 },
      { title: "broken", content: "no", url: "not a url", score: .9 },
      { title: 12, content: null, url: "https://example.com/b", score: Number.POSITIVE_INFINITY },
    ] }));
    const service = new TavilySearchService(fetcher, "secret", () => "2026-07-22T00:00:00.000Z");
    const question = `  ${"😀".repeat(450)} knowledge document secret  `;
    const evidence = await service.search(question);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret", "Content-Type": "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init?.body as string);
    expect(Array.from(body.query)).toHaveLength(400);
    expect(body).toEqual({ query: "😀".repeat(400), search_depth: "basic", max_results: 5 });
    expect(evidence).toEqual([
      { id: "web:1", sourceType: "web", title: "First", url: "https://example.com/a", text: "useful snippet", pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-22T00:00:00.000Z", score: .8 },
      { id: "web:2", sourceType: "web", title: "https://example.com/b", url: "https://example.com/b", text: "", pageNumber: null, sectionPath: null, paragraphIndex: null, retrievedAt: "2026-07-22T00:00:00.000Z", score: 0 },
    ]);
  });

  it.each([
    [429, { error: "rate limit" }, "rate_limited"],
    [403, { detail: "quota exceeded" }, "quota_exceeded"],
    [400, {}, "permanent"],
    [500, {}, "retryable"],
  ] as const)("maps HTTP %s", async (status, body, reason) => {
    const service = new TavilySearchService(vi.fn(async () => json(body, status)), "key");
    await expect(service.search("question")).rejects.toMatchObject({ reason } satisfies Partial<TavilySearchError>);
  });

  it("distinguishes bounded 429 quota detail from ordinary rate limiting", async () => {
    await expect(new TavilySearchService(vi.fn(async () => new Response(JSON.stringify({ detail: `credit exhausted ${"x".repeat(20_000)}` }), { status: 429 })), "key").search("q")).rejects.toMatchObject({ reason: "quota_exceeded" });
    await expect(new TavilySearchService(vi.fn(async () => new Response(JSON.stringify({ detail: "too many requests" }), { status: 429 })), "key").search("q")).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("applies the absolute timeout while an error body never yields", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    const pending = expect(new TavilySearchService(vi.fn(async () => new Response(body, { status: 429 })), "key").search("q")).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(8_000); await pending; vi.useRealTimers();
  });

  it("bounds bytes before decoding an oversized first error chunk and cancels the body", async () => {
    const cancel = vi.fn(); const bytes = new TextEncoder().encode(`credit exhausted ${"界".repeat(2_000_000)}`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel });
    await expect(new TavilySearchService(vi.fn(async () => new Response(body, { status: 429 })), "key").search("q")).rejects.toMatchObject({ reason: "quota_exceeded" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps timeout, network, and malformed responses distinctly", async () => {
    vi.useFakeTimers();
    const hanging = new TavilySearchService(vi.fn<Fetcher>((_u, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))), "key");
    const timed = expect(hanging.search("question")).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(8_000);
    await timed;
    vi.useRealTimers();
    await expect(new TavilySearchService(vi.fn(async () => { throw new Error("offline"); }), "key").search("q")).rejects.toMatchObject({ reason: "network" });
    await expect(new TavilySearchService(vi.fn(async () => new Response("oops")), "key").search("q")).rejects.toMatchObject({ reason: "malformed" });
    await expect(new TavilySearchService(vi.fn(async () => json({ results: "bad" })), "key").search("q")).rejects.toMatchObject({ reason: "malformed" });
  });
});
