export type KnowledgeFileKind = "pdf" | "docx" | "text" | "jpeg" | "png";
export type ValidatedKnowledgeFile = { kind: KnowledgeFileKind; mimeType: string; extension: string };

export class KnowledgeFileError extends Error {
  constructor(public readonly code: "unsupported_type" | "file_too_large" | "encrypted_document" | "invalid_file" | "single_file_required") {
    super(code);
  }
}

const MAX_BYTES = 10 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function validateKnowledgeFile(file: File): Promise<ValidatedKnowledgeFile> {
  if (file.size > MAX_BYTES) throw new KnowledgeFileError("file_too_large");
  if (file.size === 0) throw new KnowledgeFileError("invalid_file");

  const supported = new Set(["application/pdf", DOCX_MIME, "text/plain", "image/jpeg", "image/png"]);
  if (!supported.has(file.type)) throw new KnowledgeFileError("unsupported_type");
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());

  if (file.type === "application/pdf") {
    if (!starts(head, [0x25,0x50,0x44,0x46,0x2d])) throw new KnowledgeFileError("invalid_file");
    const body = new TextDecoder("latin1").decode(await file.arrayBuffer());
    if (/\/Encrypt\b/.test(body)) throw new KnowledgeFileError("encrypted_document");
    if (!/^%PDF-1\.[0-9][\r\n]/.test(body) || !/%%EOF\s*$/.test(body) || body.length < 20) throw new KnowledgeFileError("invalid_file");
    return { kind: "pdf", mimeType: file.type, extension: ".pdf" };
  }
  if (file.type === DOCX_MIME) {
    if (starts(head, [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])) throw new KnowledgeFileError("encrypted_document");
    if (!starts(head, [0x50,0x4b,0x03,0x04])) throw new KnowledgeFileError("invalid_file");
    const entries = zipLocalEntryNames(new Uint8Array(await file.arrayBuffer()));
    if (!entries.has("[Content_Types].xml") || !entries.has("word/document.xml")) throw new KnowledgeFileError("invalid_file");
    return { kind: "docx", mimeType: file.type, extension: ".docx" };
  }
  if (file.type === "image/jpeg") {
    if (!starts(head, [0xff,0xd8,0xff])) throw new KnowledgeFileError("invalid_file");
    validateJpeg(new Uint8Array(await file.arrayBuffer()));
    return { kind: "jpeg", mimeType: file.type, extension: ".jpg" };
  }
  if (file.type === "image/png") {
    if (!starts(head, [137,80,78,71,13,10,26,10])) throw new KnowledgeFileError("invalid_file");
    validatePng(new Uint8Array(await file.arrayBuffer()));
    return { kind: "png", mimeType: file.type, extension: ".png" };
  }
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await file.arrayBuffer()); }
  catch { throw new KnowledgeFileError("invalid_file"); }
  return { kind: "text", mimeType: file.type, extension: ".txt" };
}

function starts(actual: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => actual[index] === value);
}

function zipLocalEntryNames(bytes: Uint8Array): Set<string> {
  const names = new Set<string>(); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x02014b50) break;
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new KnowledgeFileError("invalid_file");
    const flags = view.getUint16(offset + 6, true); const compressedSize = view.getUint32(offset + 18, true); const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30; const dataStart = nameStart + nameLength + extraLength; const next = dataStart + compressedSize;
    if (!nameLength || next > bytes.length) throw new KnowledgeFileError("invalid_file");
    if ((flags & 1) !== 0) throw new KnowledgeFileError("encrypted_document");
    try { names.add(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.slice(nameStart, nameStart + nameLength))); }
    catch { throw new KnowledgeFileError("invalid_file"); }
    offset = next;
  }
  return names;
}

function validateJpeg(bytes: Uint8Array): void {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new KnowledgeFileError("invalid_file");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { if (offset !== bytes.length) throw new KnowledgeFileError("invalid_file"); return; }
    if (marker === undefined || marker === 0xd8 || marker === 0x00 || offset + 2 > bytes.length) throw new KnowledgeFileError("invalid_file");
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) throw new KnowledgeFileError("invalid_file");
    offset += length;
  }
  throw new KnowledgeFileError("invalid_file");
}

function validatePng(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 8; let index = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new KnowledgeFileError("invalid_file");
    const length = view.getUint32(offset); const type = new TextDecoder("ascii").decode(bytes.slice(offset + 4, offset + 8));
    const next = offset + 12 + length; if (!/^[A-Za-z]{4}$/.test(type) || next > bytes.length) throw new KnowledgeFileError("invalid_file");
    if (index++ === 0 && (type !== "IHDR" || length !== 13 || view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0)) throw new KnowledgeFileError("invalid_file");
    if (type === "IEND") { if (length !== 0 || next !== bytes.length) throw new KnowledgeFileError("invalid_file"); return; }
    offset = next;
  }
  throw new KnowledgeFileError("invalid_file");
}
