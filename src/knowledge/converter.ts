export type ConversionKind = "pdf" | "docx" | "text" | "markdown" | "jpeg" | "png";
export type ConversionSource = { documentId: string; indexVersion: number; blob: Blob; kind: ConversionKind; name: string };
export type PageDiagnostics = { nonWhitespaceCharacters: number; replacementRatio: number; controlRatio: number; hasReadableContent: boolean; ocrStatus?: "unknown" };
export type ConvertedPage = { pageNumber: number | null; markdown: string; ocrApplied: boolean | null; diagnostics: PageDiagnostics };
export type ConvertedDocument = {
  documentId: string; indexVersion: number; kind: ConversionKind; name: string; tokens: number; pages: ConvertedPage[];
};
export type ConversionErrorCode = "conversion_timeout" | "conversion_rate_limited" | "conversion_upstream" | "conversion_failed" | "invalid_page_markers" | "page_limit_exceeded" | "low_quality_output";

export class ConversionError extends Error {
  constructor(public readonly code: ConversionErrorCode, public readonly retryable: boolean) { super(code); this.name = "ConversionError"; }
}

type ProviderResponse =
  | { id: string; name: string; mimeType: string; format: "markdown"; tokens: number; data: string }
  | { id: string; name: string; mimeType: string; format: "error"; error: string };
type MarkdownAI = { toMarkdown(input: { name: string; blob: Blob }): Promise<unknown> };
type TimeoutSchedule = (milliseconds: number, reject: (error: ConversionError) => void) => () => void;
type ConverterOptions = { schedule?: TimeoutSchedule };

export class DocumentConverter {
  constructor(private readonly ai: MarkdownAI, private readonly options: ConverterOptions = {}) {}

  async convert(source: ConversionSource): Promise<ConvertedDocument> {
    let raw: unknown, cancelTimeout = () => {};
    const timeout = new Promise<never>((_, reject) => { cancelTimeout = (this.options.schedule ?? defaultSchedule)(30_000, reject); });
    try {
      raw = await Promise.race([this.ai.toMarkdown({ name: source.name, blob: source.blob }), timeout]);
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      throw classifyError(error);
    } finally { cancelTimeout(); }
    if (!isProviderResponse(raw) || raw.format === "error") throw new ConversionError("conversion_failed", false);
    const markdown = normalizeMarkdown(raw.data);
    let pages: ConvertedPage[];
    if (source.kind === "pdf") pages = pdfPages(markdown);
    else {
      const diagnostics = qualityDiagnostics(markdown);
      const image = source.kind === "jpeg" || source.kind === "png";
      pages = [{ pageNumber: image ? 1 : null, markdown, ocrApplied: image, diagnostics }];
    }
    return { documentId: source.documentId, indexVersion: source.indexVersion, kind: source.kind, name: source.name, tokens: raw.tokens, pages };
  }
}

function defaultSchedule(milliseconds: number, reject: (error: ConversionError) => void): () => void {
  const handle = setTimeout(() => reject(new ConversionError("conversion_timeout", true)), milliseconds);
  return () => clearTimeout(handle);
}

function classifyError(error: unknown): ConversionError {
  const value = error as { name?: unknown; status?: unknown };
  if (value?.name === "AbortError") return new ConversionError("conversion_timeout", true);
  if (value?.status === 429) return new ConversionError("conversion_rate_limited", true);
  if (typeof value?.status === "number" && value.status >= 500 && value.status <= 599) return new ConversionError("conversion_upstream", true);
  return new ConversionError("conversion_failed", false);
}

function isProviderResponse(value: unknown): value is ProviderResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.mimeType !== "string") return false;
  return v.format === "error" ? typeof v.error === "string" : v.format === "markdown" && typeof v.data === "string" && typeof v.tokens === "number" && Number.isSafeInteger(v.tokens) && v.tokens >= 0;
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
}

function pdfPages(markdown: string): ConvertedPage[] {
  const marker = /^### Page (\d+)$/gm, matches = [...markdown.matchAll(marker)];
  if (!matches.length) throw new ConversionError("invalid_page_markers", false);
  const preamble = markdown.slice(0, matches[0]!.index);
  if (!validPdfPreamble(preamble)) throw new ConversionError("invalid_page_markers", false);
  if (matches.length > 100) throw new ConversionError("page_limit_exceeded", false);
  const pages: ConvertedPage[] = [];
  for (let index = 0; index < matches.length; index++) {
    const number = Number(matches[index]![1]);
    if (number !== index + 1) throw new ConversionError("invalid_page_markers", false);
    const start = matches[index]!.index! + matches[index]![0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const lines = markdown.slice(start, end).split("\n");
    while (lines.length && !lines[0]!.trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    const body = lines.join("\n"), content = body ? `${body}\n` : "";
    const diagnostics = qualityDiagnostics(content);
    pages.push({ pageNumber: number, markdown: content, ocrApplied: null, diagnostics: { ...diagnostics, ocrStatus: "unknown" } });
  }
  return pages;
}

function validPdfPreamble(value: string): boolean {
  if (!value.trim()) return true;
  const lines = value.split("\n").filter((line) => line.trim().length > 0); let index = 0;
  if (/^# \S(?:.*\S)?$/u.test(lines[index] ?? "")) index++;
  if (lines[index++] !== "## Metadata") return false;
  while (index < lines.length && /^- [^\s=:][^=:]*(?:=|:)\s*\S.*$/u.test(lines[index]!)) index++;
  return lines[index++] === "## Contents" && index === lines.length;
}

function qualityDiagnostics(value: string): PageDiagnostics {
  const chars = [...value], nonWhitespace = chars.filter((char) => !/\s/u.test(char));
  const replacements = nonWhitespace.filter((char) => char === "\uFFFD").length;
  const controls = chars.filter((char) => { const point = char.codePointAt(0)!; return (point <= 0x1f && char !== "\n" && char !== "\r" && char !== "\t") || (point >= 0x7f && point <= 0x9f); }).length;
  const diagnostics = { nonWhitespaceCharacters: nonWhitespace.length, replacementRatio: nonWhitespace.length ? replacements / nonWhitespace.length : 0, controlRatio: nonWhitespace.length ? controls / nonWhitespace.length : 0, hasReadableContent: /[\p{L}\p{N}\u3400-\u9fff]/u.test(value) };
  if (!value.trim() || !nonWhitespace.length || diagnostics.replacementRatio > 0.02 || diagnostics.controlRatio > 0.01 || !diagnostics.hasReadableContent) throw new ConversionError("low_quality_output", false);
  return diagnostics;
}
