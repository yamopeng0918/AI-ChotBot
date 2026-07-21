const MAX_BYTES = 2 * 1024 * 1024;
const ENDPOINT = "https://api.tavily.com/extract";

export type KnowledgeUrlErrorCode = "invalid_source" | "source_disallowed" | "source_unavailable";
export class KnowledgeUrlError extends Error {
  constructor(readonly code: KnowledgeUrlErrorCode) { super(code); }
}

export interface SafeUrlFetcher {
  fetchStaticArticle(url: string): Promise<{ finalUrl: string; title: string; html: string; fetchedAt: string }>;
}

export function normalizeKnowledgeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new KnowledgeUrlError("invalid_source"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new KnowledgeUrlError("invalid_source");
  url.hash = "";
  if (new TextEncoder().encode(url.href).byteLength > 2048) throw new KnowledgeUrlError("invalid_source");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || !isGloballyRoutableLiteralOrHostname(hostname)) throw new KnowledgeUrlError("invalid_source");
  return url.href;
}

export class TavilySafeUrlFetcher implements SafeUrlFetcher {
  constructor(private readonly fetcher: typeof fetch, private readonly apiKey: string, private readonly now = () => new Date()) {}

  async fetchStaticArticle(value: string) {
    const requested = normalizeKnowledgeUrl(value);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000); let response: Response;
    try {
      response = await this.fetcher(ENDPOINT, {
        method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ urls: [requested], extract_depth: "basic", format: "markdown" }), signal: controller.signal,
      });
    } catch { clearTimeout(timeout); throw new KnowledgeUrlError("source_unavailable"); }
    try {
      if (response.status === 429 || response.status >= 500) { await cancelBody(response); throw new KnowledgeUrlError("source_unavailable"); }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) { await cancelBody(response); throw new KnowledgeUrlError("invalid_source"); }
      const bytes = await readBounded(response, controller.signal);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw new KnowledgeUrlError("invalid_source"); }
      if (isDisallowed(payload)) throw new KnowledgeUrlError("source_disallowed");
      if (!response.ok) throw new KnowledgeUrlError("invalid_source");
      const results = record(payload)?.results;
      if (!Array.isArray(results) || results.length !== 1) throw new KnowledgeUrlError("invalid_source");
      const result = record(results[0]);
      if (!result || typeof result.url !== "string" || typeof result.raw_content !== "string" || !result.raw_content.trim()) throw new KnowledgeUrlError("invalid_source");
      let returned: string;
      try { returned = normalizeKnowledgeUrl(result.url); } catch { throw new KnowledgeUrlError("invalid_source"); }
      if (returned !== requested || new TextEncoder().encode(result.raw_content).byteLength > MAX_BYTES) throw new KnowledgeUrlError("invalid_source");
      const fallback = new URL(requested).hostname;
      const title = cleanTitle(typeof result.title === "string" ? result.title : fallback) || fallback;
      return { finalUrl: requested, title, html: result.raw_content, fetchedAt: this.now().toISOString() };
    } finally { clearTimeout(timeout); }
  }
}

async function readBounded(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(new DOMException("Aborted", "AbortError")); signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]); if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); throw new KnowledgeUrlError("invalid_source"); }
      chunks.push(value);
    }
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new KnowledgeUrlError("source_unavailable");
    if (error instanceof KnowledgeUrlError) throw error;
    throw new KnowledgeUrlError("invalid_source");
  } finally { signal?.removeEventListener("abort", onAbort); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function cancelBody(response: Response) { if (response.body) await Promise.allSettled([response.body.cancel()]); }

function cleanTitle(value: string) { return [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")].slice(0, 200).join(""); }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isDisallowed(value: unknown): boolean {
  const failed = record(value)?.failed_results;
  return Array.isArray(failed) && failed.some((item) => /robots|access.?denied|disallow/i.test(String(record(item)?.error ?? "")));
}

function isGloballyRoutableLiteralOrHostname(hostname: string): boolean {
  const raw = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (raw.includes(":")) {
    const ip = parseIpv6(raw); if (ip === null) return true;
    const in6 = (base: bigint, bits: number) => (ip >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
    if (!in6(0x2000n << 112n, 3)) return false;
    if (in6(0x2001n << 112n, 23) || in6(0x20010db8n << 96n, 32) || in6(0x2002n << 112n, 16) || in6(0x3fffn << 112n, 20) || in6(0x5f00n << 112n, 16)) return false;
    return true;
  }
  if (!/^\d+(?:\.\d+){3}$/.test(raw)) return true;
  const parts = raw.split(".").map(Number); return !parts.some((p) => p > 255) && isGlobalV4(((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!);
}
function isGlobalV4(ip: number) {
  const cidr = (base: number, bits: number) => Math.floor(ip / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
  return ![
    [0x00000000,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],
    [0xc0000000,24],[0xc0000200,24],[0xc0586300,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],
    [0xcb007100,24],[0xe0000000,4],[0xf0000000,4],
  ].some(([base,bits]) => cidr(base!, bits!));
}
function parseIpv6(value: string): bigint | null {
  const halves = value.split("::"); if (halves.length > 2) return null;
  const parse = (part: string) => part ? part.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const left = parse(halves[0]!), right = parse(halves[1] ?? ""); const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0) || [...left, ...right].some((x) => !Number.isFinite(x) || x < 0 || x > 0xffff)) return null;
  return [...left, ...Array(missing).fill(0), ...right].reduce((sum: bigint, word) => (sum << 16n) | BigInt(word), 0n);
}
