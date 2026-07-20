import { describe, expect, test } from "vitest";
import { validateKnowledgeFile } from "../../src/knowledge/file-validation";

const validDocx = zipEntries(["[Content_Types].xml", "word/document.xml"]);

describe("validateKnowledgeFile", () => {
  test.each([
    [new File([validPdf()], "a.pdf", { type: "application/pdf" }), "pdf", ".pdf"],
    [new File([validDocx], "a.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "docx", ".docx"],
    [new File(["hello 世界"], "a.txt", { type: "text/plain" }), "text", ".txt"],
    [new File([validJpeg()], "a.jpg", { type: "image/jpeg" }), "jpeg", ".jpg"],
    [new File([validPng()], "a.png", { type: "image/png" }), "png", ".png"],
  ])("accepts a signature-matched file", async (file, kind, extension) => {
    await expect(validateKnowledgeFile(file)).resolves.toEqual(expect.objectContaining({ kind, extension }));
  });

  test("accepts exactly the 10 MiB boundary", async () => {
    const tail = new TextEncoder().encode("\n%%EOF");
    const file = new File(["%PDF-1.7\n", new Uint8Array(10 * 1024 * 1024 - 9 - tail.length), tail], "a.pdf", { type: "application/pdf" });
    await expect(validateKnowledgeFile(file)).resolves.toMatchObject({ kind: "pdf" });
  });

  test.each([
    [new File([], "empty.txt", { type: "text/plain" }), "invalid_file"],
    [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.txt", { type: "text/plain" }), "file_too_large"],
    [new File(["MZ executable"], "fake.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-"], "short.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-1.7\n/Encrypt 1 0 R"], "secret.pdf", { type: "application/pdf" }), "encrypted_document"],
    [new File([new Uint8Array([0x50,0x4b,0x03,0x04])], "bad.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File([zipEntries(["[Content_Types].xml", "word/document.xml"], 1)], "encrypted.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "encrypted_document"],
    [new File([new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0,0,0])], "protected.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "encrypted_document"],
    [new File([new Uint8Array([0xff,0xd8,0xff])], "short.jpg", { type: "image/jpeg" }), "invalid_file"],
    [new File([new Uint8Array([137,80,78,71,13,10,26,10])], "short.png", { type: "image/png" }), "invalid_file"],
    [new File([new Uint8Array([0x50,0x4b,0x03,0x04,...new TextEncoder().encode("[Content_Types].xml word/document.xml")])], "spoof.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File(["hello"], "a.exe", { type: "application/octet-stream" }), "unsupported_type"],
  ])("rejects invalid input with a stable code", async (file, code) => {
    await expect(validateKnowledgeFile(file)).rejects.toMatchObject({ code });
  });
});

function zipEntries(names: string[], flags = 0): Uint8Array {
  const chunks = names.map((name) => {
    const encoded = new TextEncoder().encode(name); const value = new Uint8Array(30 + encoded.length);
    value.set([0x50,0x4b,0x03,0x04,20,0], 0); new DataView(value.buffer).setUint16(6, flags, true);
    new DataView(value.buffer).setUint16(26, encoded.length, true); value.set(encoded, 30); return value;
  });
  const size = chunks.reduce((sum, value) => sum + value.length, 0); const output = new Uint8Array(size + 4);
  let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  output.set([0x50,0x4b,0x01,0x02], offset); return output;
}
function validPdf() { return "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF"; }
function validJpeg() { return new Uint8Array([0xff,0xd8,0xff,0xe0,0,2,0xff,0xd9]); }
function validPng() {
  const value = new Uint8Array(8 + 25 + 12); value.set([137,80,78,71,13,10,26,10]); const view = new DataView(value.buffer);
  view.setUint32(8,13); value.set(new TextEncoder().encode("IHDR"),12); view.setUint32(16,1); view.setUint32(20,1); value.set([8,2,0,0,0],24);
  view.setUint32(33,0); value.set(new TextEncoder().encode("IEND"),37); return value;
}
