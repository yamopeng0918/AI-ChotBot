import { describe, expect, test, vi } from "vitest";
import { ConversionError, DocumentConverter } from "../../src/knowledge/converter";

const source = (kind: "pdf" | "docx" | "text" | "markdown" | "jpeg" | "png", blob = new Blob(["original"])) => ({
  documentId: "doc", indexVersion: 3, blob, kind, name: `source.${kind}`,
});
const success = (data: string) => ({ id: "provider-id", name: "source", mimeType: "text/markdown", format: "markdown" as const, tokens: 12, data });

describe("DocumentConverter", () => {
  test("passes the original blob to the direct single-file binding without invented options", async () => {
    const blob = new Blob(["pdf"]), toMarkdown = vi.fn().mockResolvedValue(success("### Page 1\nAlpha"));
    await new DocumentConverter({ toMarkdown }).convert(source("pdf", blob));
    expect(toMarkdown).toHaveBeenCalledWith({ name: "source.pdf", blob });
  });

  test("parses only consecutive explicit PDF pages and reports conservative OCR diagnostics", async () => {
    const data = "\n### Page 1\r\n# 標題  \r\nTraditional 中文 and English\r\n### Page 2\r\nSecond page";
    const converted = await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success(data)) }).convert(source("pdf"));
    expect(converted.pages).toEqual([
      { pageNumber: 1, markdown: "# 標題\nTraditional 中文 and English\n", ocrApplied: null, diagnostics: expect.objectContaining({ ocrStatus: "unknown", replacementRatio: 0, controlRatio: 0, hasReadableContent: true }) },
      { pageNumber: 2, markdown: "Second page\n", ocrApplied: null, diagnostics: { ocrStatus: "unknown", nonWhitespaceCharacters: 10, replacementRatio: 0, controlRatio: 0, hasReadableContent: true } },
    ]);
  });

  test.each(["docx", "text", "markdown"] as const)("keeps %s as one non-paged snapshot", async (kind) => {
    const converted = await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success("### Page 9\n正文")) }).convert(source(kind));
    expect(converted.pages[0]).toMatchObject({ pageNumber: null, markdown: "### Page 9\n正文", ocrApplied: false, diagnostics: { replacementRatio: 0, controlRatio: 0, hasReadableContent: true } });
  });

  test("preserves leading indentation and blank lines while removing line-trailing whitespace", async () => {
    const converted = await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success("\n  indented  \ntext\n")) }).convert(source("markdown"));
    expect(converted.pages[0]!.markdown).toBe("\n  indented\ntext\n");
  });

  test("preserves a PDF final page newline at end of file", async () => {
    const converted = await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success("### Page 1\nalpha\n")) }).convert(source("pdf"));
    expect(converted.pages[0]!.markdown).toBe("alpha\n");
  });

  test("accepts only the complete Cloudflare metadata preamble and excludes it from page text", async () => {
    const data = "# report.pdf\n\n## Metadata\n- author=Cloudflare\n- language: zh-TW\n\n## Contents\n\n### Page 1\n正文";
    const converted = await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success(data)) }).convert(source("pdf"));
    expect(converted.pages[0]!.markdown).toBe("正文\n");
  });

  test.each(["jpeg", "png"] as const)("marks %s conversion as OCR page one", async (kind) => {
    const converted = await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success("繁體中文 and English")) }).convert(source(kind));
    expect(converted.pages[0]).toMatchObject({ pageNumber: 1, markdown: "繁體中文 and English", ocrApplied: true, diagnostics: { replacementRatio: 0, controlRatio: 0, hasReadableContent: true } });
  });

  test("reports exact accepted quality ratios at inclusive boundaries", async () => {
    const data = `${"a".repeat(97)}��\u0001`;
    const page = (await new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success(data)) }).convert(source("text"))).pages[0]!;
    expect(page.diagnostics).toEqual({ nonWhitespaceCharacters: 100, replacementRatio: 0.02, controlRatio: 0.01, hasReadableContent: true });
  });

  test.each([
    ["### Page 2\ntext", "invalid_page_markers"],
    ["### Page 1\none\n### Page 1\ntwo", "invalid_page_markers"],
    ["### Page 1\none\n### Page 3\nthree", "invalid_page_markers"],
    ["substantive preamble\n### Page 1\none", "invalid_page_markers"],
    ["Title: Annual Report\n### Page 1\none", "invalid_page_markers"],
    ["# report.pdf\n## Metadata\n- author=test\n### Page 1\none", "invalid_page_markers"],
    ["# report.pdf\n## Contents\n### Page 1\none", "invalid_page_markers"],
    ["### Page 1\n \n### Page 2\ntwo", "low_quality_output"],
    [Array.from({ length: 101 }, (_, i) => `### Page ${i + 1}\np${i + 1}`).join("\n"), "page_limit_exceeded"],
  ])("rejects invalid PDF structure with %s", async (data, code) => {
    await expect(new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success(data)) }).convert(source("pdf"))).rejects.toMatchObject({ code, retryable: false });
  });

  test.each(["", "   ", "���", "\u0001\u0002readable", "--- !!!"])("rejects low quality output %#", async (data) => {
    await expect(new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue(success(data)) }).convert(source("text"))).rejects.toMatchObject({ code: "low_quality_output", retryable: false });
  });

  test("classifies provider error responses as permanent without leaking payload", async () => {
    const promise = new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue({ id: "x", name: "x", mimeType: "x", format: "error", error: "secret" }) }).convert(source("text"));
    await expect(promise).rejects.toEqual(new ConversionError("conversion_failed", false));
  });

  test.each([
    [Object.assign(new Error("abort"), { name: "AbortError" }), "conversion_timeout", true],
    [Object.assign(new Error("rate"), { status: 429 }), "conversion_rate_limited", true],
    [Object.assign(new Error("upstream"), { status: 503 }), "conversion_upstream", true],
    [new Error("bad"), "conversion_failed", false],
  ])("classifies thrown provider failures", async (error, code, retryable) => {
    await expect(new DocumentConverter({ toMarkdown: vi.fn().mockRejectedValue(error) }).convert(source("text"))).rejects.toMatchObject({ code, retryable });
  });

  test("enforces the injectable 30 second logical timeout", async () => {
    const cancel = vi.fn(), schedule = vi.fn((_ms: number, reject: (error: ConversionError) => void) => { reject(new ConversionError("conversion_timeout", true)); return cancel; });
    await expect(new DocumentConverter({ toMarkdown: vi.fn(() => new Promise(() => {})) }, { schedule }).convert(source("text"))).rejects.toMatchObject({ code: "conversion_timeout", retryable: true });
    expect(schedule).toHaveBeenCalledWith(30_000, expect.any(Function)); expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each(["resolve", "reject"])("cancels the timer once when provider %s settles", async (mode) => {
    const cancel = vi.fn(), schedule = vi.fn(() => cancel), provider = mode === "resolve" ? vi.fn().mockResolvedValue(success("text")) : vi.fn().mockRejectedValue(new Error("bad"));
    const promise = new DocumentConverter({ toMarkdown: provider }, { schedule }).convert(source("text"));
    if (mode === "resolve") await promise; else await expect(promise).rejects.toMatchObject({ code: "conversion_failed" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid provider token count %s", async (tokens) => {
    await expect(new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue({ ...success("text"), tokens }) }).convert(source("text"))).rejects.toMatchObject({ code: "conversion_failed", retryable: false });
  });

  test("rejects array and malformed fake results", async () => {
    await expect(new DocumentConverter({ toMarkdown: vi.fn().mockResolvedValue([success("text")]) }).convert(source("text"))).rejects.toMatchObject({ code: "conversion_failed" });
  });
});
