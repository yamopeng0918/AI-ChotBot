import { describe, expect, test, vi } from "vitest";
import { KnowledgeUrlError, TavilySafeUrlFetcher, normalizeKnowledgeUrl } from "../../src/knowledge/url-safety";

describe("normalizeKnowledgeUrl", () => {
  test("normalizes a safe HTTPS URL without changing query order", () => {
    expect(normalizeKnowledgeUrl("HTTPS://ExAmPle.COM:443/a/../b?z=1&a=2#part")).toBe("https://example.com/b?z=1&a=2");
  });

  test.each([
    "http://example.com", "https://user:pass@example.com", "https://localhost", "https://x.localhost",
    "https://0.0.0.0", "https://127.0.0.1", "https://10.0.0.1", "https://172.16.0.1", "https://192.168.0.1",
    "https://169.254.169.254", "https://100.64.0.1", "https://224.0.0.1", "https://[::1]", "https://[fc00::1]",
    "https://[fe80::1]", "https://[::ffff:127.0.0.1]", "https://2130706433", "https://0x7f000001",
    "https://192.0.0.1", "https://192.0.2.1", "https://192.88.99.1", "https://198.18.0.1", "https://198.51.100.1", "https://203.0.113.1",
    "https://[100::1]", "https://[2001::1]", "https://[2001:db8::1]", "https://[2002::1]", "https://[3fff::1]", "https://[5f00::1]",
  ])("rejects unsafe URL %s", (url) => expect(() => normalizeKnowledgeUrl(url)).toThrow(KnowledgeUrlError));

  test.each(["https://8.8.8.8/", "https://192.0.1.1/", "https://198.17.255.255/", "https://198.20.0.1/", "https://[2001:4860:4860::8888]/", "https://[2606:4700:4700::1111]/"])("accepts globally routable literal %s", (url) => {
    expect(normalizeKnowledgeUrl(url)).toBe(url);
  });
});

describe("TavilySafeUrlFetcher", () => {
  test("calls only the fixed provider endpoint with bounded contract", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ url: "https://example.com/a", title: "A\u0000 title", raw_content: "# Article" }] }), { headers: { "content-type": "application/json", "content-length": "120" } }));
    const adapter = new TavilySafeUrlFetcher(fetcher, "tavily-secret", () => new Date("2026-07-20T00:00:00Z"));
    await expect(adapter.fetchStaticArticle("https://example.com/a#x")).resolves.toEqual({ finalUrl: "https://example.com/a", title: "A title", html: "# Article", fetchedAt: "2026-07-20T00:00:00.000Z" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(endpoint).toBe("https://api.tavily.com/extract");
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer tavily-secret", "content-type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ urls: ["https://example.com/a"], extract_depth: "basic", format: "markdown" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    [{ results: [{ url: "https://evil.example/", raw_content: "x" }] }, "invalid_source"],
    [{ results: [{ url: "https://example.com/", raw_content: "" }] }, "invalid_source"],
    [{ failed_results: [{ url: "https://example.com/", error: "Blocked by robots.txt" }] }, "source_disallowed"],
  ])("maps malformed or disallowed result", async (payload, code) => {
    const adapter = new TavilySafeUrlFetcher(async () => new Response(JSON.stringify(payload)), "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code });
  });

  test.each([429, 500])("maps provider %s to unavailable", async (status) => {
    const adapter = new TavilySafeUrlFetcher(async () => new Response("no", { status }), "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "source_unavailable" });
  });

  test("rejects a response declared over 2 MiB", async () => {
    const adapter = new TavilySafeUrlFetcher(async () => new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }), "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "invalid_source" });
  });

  test("stops reading an undeclared response after the 2 MiB bound", async () => {
    let cancelled = false; const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } });
    const adapter = new TavilySafeUrlFetcher(async () => new Response(stream), "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "invalid_source" });
    expect(cancelled).toBe(true);
  });

  test("maps timeout or network rejection to unavailable", async () => {
    const adapter = new TavilySafeUrlFetcher(async () => { throw new DOMException("timed out", "AbortError"); }, "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "source_unavailable" });
  });

  test("uses the same timeout budget while the response body stalls", async () => {
    vi.useFakeTimers(); let cancelled = false;
    try {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
      const adapter = new TavilySafeUrlFetcher(async () => new Response(stream), "key"); const assertion = expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "source_unavailable" });
      await vi.advanceTimersByTimeAsync(10_000); await assertion; expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  test("parses explicit robots denial from a bounded 4xx payload", async () => {
    const adapter = new TavilySafeUrlFetcher(async () => new Response(JSON.stringify({ failed_results: [{ url: "https://example.com/", error: "Access denied by robots.txt" }] }), { status: 403 }), "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "source_disallowed" });
  });

  test("cancels an early unavailable response body", async () => {
    let cancelled = false; const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const adapter = new TavilySafeUrlFetcher(async () => new Response(stream, { status: 503 }), "key");
    await expect(adapter.fetchStaticArticle("https://example.com/")).rejects.toMatchObject({ code: "source_unavailable" }); expect(cancelled).toBe(true);
  });
});
