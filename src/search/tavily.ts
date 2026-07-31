import type { KnowledgeEvidence } from "../knowledge/types";

export type TavilySearchErrorReason = "rate_limited" | "quota_exceeded" | "timeout" | "permanent" | "retryable" | "malformed" | "network";
export class TavilySearchError extends Error {
  constructor(readonly reason: TavilySearchErrorReason) { super(reason); this.name = "TavilySearchError"; }
}
export interface WebSearchService { search(query: string): Promise<KnowledgeEvidence[]>; }
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class TavilySearchService implements WebSearchService {
  constructor(private readonly fetcher: Fetcher, private readonly apiKey: string,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async search(query: string): Promise<KnowledgeEvidence[]> {
    const bounded = Array.from(query.trim()).slice(0, 400).join("");
    if (!bounded) throw new RangeError("query must not be empty");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher.call(globalThis, "https://api.tavily.com/search", { method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: bounded, search_depth: "basic", max_results: 5 }), signal: controller.signal });
      if (!response.ok) throw await httpError(response, controller.signal);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new TavilySearchError("malformed"); }
      if (!isRecord(payload) || !Array.isArray(payload.results)) throw new TavilySearchError("malformed");
      const seen = new Set<string>(), evidence: KnowledgeEvidence[] = [], retrievedAt = this.now();
      for (const raw of payload.results.slice(0, 5)) {
        if (!isRecord(raw) || typeof raw.url !== "string") continue;
        const url = canonicalHttps(raw.url); if (!url || seen.has(url)) continue; seen.add(url);
        evidence.push({ id: `web:${evidence.length + 1}`, sourceType: "web",
          title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : url, url,
          text: typeof raw.content === "string" ? raw.content.trim() : "", pageNumber: null, sectionPath: null,
          paragraphIndex: null, retrievedAt, score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : 0 });
      }
      return evidence;
    } catch (error) {
      if (error instanceof TavilySearchError) throw error;
      if (controller.signal.aborted) throw new TavilySearchError("timeout");
      throw new TavilySearchError("network");
    } finally { clearTimeout(timeout); }
  }
}

async function httpError(response: Response, signal: AbortSignal): Promise<TavilySearchError> {
  let detail = ""; try { detail = (await boundedText(response, 4_096, signal)).toLowerCase(); } catch (error) { if (signal.aborted) throw error; }
  if (response.status === 429) return new TavilySearchError(/quota|credit|exhausted|usage limit/.test(detail) ? "quota_exceeded" : "rate_limited");
  if ((response.status === 402 || response.status === 403) && /quota|credit|usage|limit/.test(detail)) return new TavilySearchError("quota_exceeded");
  return new TavilySearchError(response.status >= 500 ? "retryable" : "permanent");
}
async function boundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder(); const chunks: string[] = []; let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await abortableRead(reader, signal); if (done) break;
      const chunk = value.subarray(0, limit - bytes); bytes += chunk.byteLength;
      chunks.push(decoder.decode(chunk, { stream: bytes < limit }));
      if (value.byteLength > chunk.byteLength || bytes >= limit) break;
    }
    return chunks.join("");
  } finally { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch {} }
}
function abortableRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => { void reader.cancel().catch(() => undefined); reject(new DOMException("aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function canonicalHttps(value: string): string | null {
  try { const url = new URL(value); if (url.protocol !== "https:") return null; url.hash = ""; return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/"); }
  catch { return null; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
