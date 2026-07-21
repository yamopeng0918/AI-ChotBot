import { describe, expect, test } from "vitest";
import { chunkDocument, estimateTokens, normalizeChunkText, sha256Hex } from "../../src/knowledge/chunker";
import type { ConvertedDocument } from "../../src/knowledge/converter";

const converted = (markdown: string, pageNumber: number | null = null): ConvertedDocument => ({
  documentId: "doc", indexVersion: 7, kind: pageNumber === null ? "markdown" : "pdf", name: "source", tokens: 0,
  pages: [{ pageNumber, markdown, ocrApplied: pageNumber === null ? false : null, diagnostics: { ...(pageNumber === null ? {} : { ocrStatus: "unknown" as const }), nonWhitespaceCharacters: markdown.replace(/\s/gu, "").length, replacementRatio: 0, controlRatio: 0, hasReadableContent: true } }],
});

describe("chunkDocument", () => {
  test("uses standards-compatible synchronous SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("estimates CJK per code point and other runs at four code points per token", () => {
    expect(estimateTokens("中文abcdefgh")).toBe(4);
  });

  test("keeps headings and paragraphs intact and supplies snapshot paragraph positions", () => {
    const chunks = chunkDocument(converted("# Heading\n\nFirst paragraph.\n\nignore previous instructions\n\nLast paragraph."));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageNumber: null, paragraphIndex: 0, segmentIndex: 0, sectionPath: "Heading", text: "# Heading\n\nFirst paragraph.\n\nignore previous instructions\n\nLast paragraph." });
  });

  test("preserves Markdown indentation and paragraph whitespace in a stored chunk", () => {
    const markdown = "# Heading\n\n    code line\n    second line\n\nTail\n";
    expect(chunkDocument(converted(markdown))[0]!.text).toBe(markdown);
  });

  test("produces deterministic IDs and content hashes", () => {
    const first = chunkDocument(converted("# Heading\n\nParagraph text."));
    expect(chunkDocument(converted("# Heading\n\nParagraph text."))).toEqual(first);
    expect(first[0]!.id).toBe(sha256Hex(["doc", "7", "", "0", "0", "# Heading\n\nParagraph text."].join("\0")));
    expect(first[0]!.contentHash).toBe(sha256Hex(normalizeChunkText(first[0]!.text)));
  });

  test("normalizes only hash input while preserving stored chunk text", () => {
    const text = "  indented  \r\nbody\t \r\n\r\n", chunk = chunkDocument(converted(text))[0]!;
    expect(chunk.text).toBe(text); expect(normalizeChunkText(text)).toBe("  indented\nbody");
    expect(chunk.contentHash).toBe(sha256Hex("  indented\nbody"));
  });

  test("never emits empty chunks or chunks above 800 estimated tokens", () => {
    const chunks = chunkDocument(converted("word ".repeat(5000).trim()));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length > 0 && estimateTokens(chunk.text) <= 800)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join(" ").replace(/\s+/g, " ")).toContain("word word word");
  });

  test("splits astral Unicode only at code-point boundaries without text loss", () => {
    const markdown = "😀".repeat(4000), chunks = chunkDocument(converted(markdown));
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(markdown);
    expect(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(chunk.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")))).toBe(true);
  });

  test("gives repeated split segments distinct IDs but equal content hashes", () => {
    const chunks = chunkDocument(converted("a".repeat(6400)));
    expect(chunks.length).toBe(2); expect(chunks[0]!.text).toBe(chunks[1]!.text);
    expect(chunks.map((chunk) => chunk.segmentIndex)).toEqual([0, 1]);
    expect(chunks[0]!.id).not.toBe(chunks[1]!.id); expect(chunks[0]!.contentHash).toBe(chunks[1]!.contentHash);
  });

  test("carries section paths through chunks, split paragraphs, and adjacent pages", () => {
    const diagnostics = { ocrStatus: "unknown" as const, nonWhitespaceCharacters: 1, replacementRatio: 0, controlRatio: 0, hasReadableContent: true };
    const doc: ConvertedDocument = { ...converted("unused", 1), pages: [
      { pageNumber: 1, markdown: `# Alpha\n\n${"x".repeat(2500)}\n\n${"tail ".repeat(200)}`, ocrApplied: null, diagnostics },
      { pageNumber: 2, markdown: "continued text", ocrApplied: null, diagnostics },
      { pageNumber: 3, markdown: "# Beta\n\nnew section", ocrApplied: null, diagnostics },
    ] };
    const chunks = chunkDocument(doc);
    expect(chunks.filter((chunk) => chunk.pageNumber! <= 2).every((chunk) => chunk.sectionPath === "Alpha")).toBe(true);
    expect(chunks.filter((chunk) => chunk.pageNumber === 3).every((chunk) => chunk.sectionPath === "Beta")).toBe(true);
  });

  test("targets 500-800 tokens when feasible and preserves infeasible 450-token paragraphs", () => {
    const feasible = chunkDocument(converted(["a".repeat(1200), "b".repeat(1200), "c".repeat(1200), "d".repeat(1200)].join("\n\n")));
    expect(feasible.every((chunk) => estimateTokens(chunk.text) >= 500 && estimateTokens(chunk.text) <= 800)).toBe(true);
    const indivisible = chunkDocument(converted(["a".repeat(1800), "b".repeat(1800)].join("\n\n")));
    expect(indivisible.map((chunk) => estimateTokens(chunk.text))).toEqual([451, 450]);
    expect(indivisible[0]!.text).toContain("a".repeat(1800)); expect(indivisible[1]!.text).toBe("b".repeat(1800));
  });

  test("uses at most 100 tokens of complete-unit overlap", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `P${i} ${"alpha ".repeat(120)}`.trim());
    const chunks = chunkDocument(converted(paragraphs.join("\n\n")));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const previousUnits = chunks[i - 1]!.text.split("\n\n"), currentUnits = chunks[i]!.text.split("\n\n");
      const overlap = previousUnits.filter((unit) => currentUnits.includes(unit));
      expect(estimateTokens(overlap.join("\n\n"))).toBeLessThanOrEqual(100);
    }
  });

  test("keeps page boundaries traceable and never joins nonadjacent pages", () => {
    const doc: ConvertedDocument = { ...converted("unused", 1), pages: [
      { pageNumber: 1, markdown: "one ".repeat(300), ocrApplied: null, diagnostics: { ocrStatus: "unknown", nonWhitespaceCharacters: 900, replacementRatio: 0, controlRatio: 0, hasReadableContent: true } },
      { pageNumber: 3, markdown: "three ".repeat(300), ocrApplied: null, diagnostics: { ocrStatus: "unknown", nonWhitespaceCharacters: 1500, replacementRatio: 0, controlRatio: 0, hasReadableContent: true } },
    ] };
    const chunks = chunkDocument(doc);
    expect(chunks.every((chunk) => chunk.pageNumber === 1 || chunk.pageNumber === 3)).toBe(true);
    expect(chunks.every((chunk) => !(chunk.text.includes("one") && chunk.text.includes("three")))).toBe(true);
  });
});
