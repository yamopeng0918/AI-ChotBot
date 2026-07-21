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
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isSpecialIp(hostname)) throw new KnowledgeUrlError("invalid_source");
  return url.href;
}

export class TavilySafeUrlFetcher implements SafeUrlFetcher {
  constructor(private readonly fetcher: typeof fetch, private readonly apiKey: string, private readonly now = () => new Date()) {}

  async fetchStaticArticle(value: string) {
    const requested = normalizeKnowledgeUrl(value);
    let response: Response;
    try {
      response = await this.fetcher(ENDPOINT, {
        method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ urls: [requested], extract_depth: "basic", format: "markdown" }), signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new KnowledgeUrlError("source_unavailable"); }
    if (response.status === 429 || response.status >= 500) throw new KnowledgeUrlError("source_unavailable");
    if (!response.ok) throw new KnowledgeUrlError("invalid_source");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new KnowledgeUrlError("invalid_source");
    const bytes = await readBounded(response);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw new KnowledgeUrlError("invalid_source"); }
    if (isDisallowed(payload)) throw new KnowledgeUrlError("source_disallowed");
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
  }
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); throw new KnowledgeUrlError("invalid_source"); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof KnowledgeUrlError) throw error;
    throw new KnowledgeUrlError("invalid_source");
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function cleanTitle(value: string) { return [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")].slice(0, 200).join(""); }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isDisallowed(value: unknown): boolean {
  const failed = record(value)?.failed_results;
  return Array.isArray(failed) && failed.some((item) => /robots|access.?denied|disallow/i.test(String(record(item)?.error ?? "")));
}

function isSpecialIp(hostname: string): boolean {
  const raw = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (raw.includes(":")) {
    const ip = parseIpv6(raw); if (ip === null) return false;
    const in6 = (base: bigint, bits: number) => (ip >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
    if (in6(0n, 128) || in6(1n, 128) || in6(0xfc00n << 112n, 7) || in6(0xfe80n << 112n, 10) || in6(0xff00n << 112n, 8)) return true;
    if (in6(0xffffn << 32n, 96)) return isSpecialV4(Number(ip & 0xffffffffn));
    return false;
  }
  if (!/^\d+(?:\.\d+){3}$/.test(raw)) return false;
  const parts = raw.split(".").map(Number); return parts.some((p) => p > 255) || isSpecialV4(((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!);
}
function isSpecialV4(ip: number) {
  const first = Math.floor(ip / 0x1000000), second = Math.floor(ip / 0x10000) & 255;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) || first >= 224;
}
function parseIpv6(value: string): bigint | null {
  const halves = value.split("::"); if (halves.length > 2) return null;
  const parse = (part: string) => part ? part.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const left = parse(halves[0]!), right = parse(halves[1] ?? ""); const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0) || [...left, ...right].some((x) => !Number.isFinite(x) || x < 0 || x > 0xffff)) return null;
  return [...left, ...Array(missing).fill(0), ...right].reduce((sum: bigint, word) => (sum << 16n) | BigInt(word), 0n);
}
