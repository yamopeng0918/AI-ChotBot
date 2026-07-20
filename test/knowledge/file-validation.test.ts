import { describe, expect, test } from "vitest";
import { validateKnowledgeFile } from "../../src/knowledge/file-validation";

const validDocx = zipEntries(["[Content_Types].xml", "word/document.xml"]);

describe("validateKnowledgeFile", () => {
  test.each([
    [new File(["%PDF-1.7\nbody"], "a.pdf", { type: "application/pdf" }), "pdf", ".pdf"],
    [new File([validDocx], "a.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "docx", ".docx"],
    [new File(["hello 世界"], "a.txt", { type: "text/plain" }), "text", ".txt"],
    [new File([new Uint8Array([0xff,0xd8,0xff,0xe0])], "a.jpg", { type: "image/jpeg" }), "jpeg", ".jpg"],
    [new File([new Uint8Array([137,80,78,71,13,10,26,10])], "a.png", { type: "image/png" }), "png", ".png"],
  ])("accepts a signature-matched file", async (file, kind, extension) => {
    await expect(validateKnowledgeFile(file)).resolves.toEqual(expect.objectContaining({ kind, extension }));
  });

  test("accepts exactly the 10 MiB boundary", async () => {
    const file = new File(["%PDF-", new Uint8Array(10 * 1024 * 1024 - 5)], "a.pdf", { type: "application/pdf" });
    await expect(validateKnowledgeFile(file)).resolves.toMatchObject({ kind: "pdf" });
  });

  test.each([
    [new File([], "empty.txt", { type: "text/plain" }), "invalid_file"],
    [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.txt", { type: "text/plain" }), "file_too_large"],
    [new File(["MZ executable"], "fake.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-1.7\n/Encrypt 1 0 R"], "secret.pdf", { type: "application/pdf" }), "encrypted_document"],
    [new File([new Uint8Array([0x50,0x4b,0x03,0x04])], "bad.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File([new Uint8Array([0x50,0x4b,0x03,0x04,...new TextEncoder().encode("[Content_Types].xml word/document.xml")])], "spoof.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File(["hello"], "a.exe", { type: "application/octet-stream" }), "unsupported_type"],
  ])("rejects invalid input with a stable code", async (file, code) => {
    await expect(validateKnowledgeFile(file)).rejects.toMatchObject({ code });
  });
});

function zipEntries(names: string[]): Uint8Array {
  const chunks = names.map((name) => {
    const encoded = new TextEncoder().encode(name); const value = new Uint8Array(30 + encoded.length);
    value.set([0x50,0x4b,0x03,0x04,20,0,0,0,0,0], 0);
    new DataView(value.buffer).setUint16(26, encoded.length, true); value.set(encoded, 30); return value;
  });
  const size = chunks.reduce((sum, value) => sum + value.length, 0); const output = new Uint8Array(size + 4);
  let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  output.set([0x50,0x4b,0x01,0x02], offset); return output;
}
