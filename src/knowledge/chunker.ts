import type { ConvertedDocument } from "./converter";

export type KnowledgeChunkDraft = { id: string; documentId: string; indexVersion: number; text: string; pageNumber: number | null; paragraphIndex: number; segmentIndex: number; sectionPath: string | null; contentHash: string };
type Unit = { text: string; paragraphIndex: number; segmentIndex: number; sectionPath: string | null };

/** CJK code points cost one token; each contiguous non-CJK run costs ceil(code points / 4). */
export function estimateTokens(text: string): number {
  let total = 0, run = 0;
  for (const char of text) {
    if (isCjk(char.codePointAt(0)!)) { if (run) total += Math.ceil(run / 4); run = 0; total++; }
    else run++;
  }
  return total + Math.ceil(run / 4);
}

export function chunkDocument(document: ConvertedDocument): KnowledgeChunkDraft[] {
  const drafts: KnowledgeChunkDraft[] = []; let currentSection: string | null = null, previousPageNumber: number | null = null;
  for (const page of document.pages) {
    if (page.pageNumber !== null) {
      if (previousPageNumber !== null && page.pageNumber !== previousPageNumber + 1) currentSection = null;
      previousPageNumber = page.pageNumber;
    }
    const parsed = paragraphUnits(page.markdown, currentSection); currentSection = parsed.finalSection;
    const units = parsed.units.flatMap(splitOversizedUnit);
    let current: Unit[] = [];
    for (const unit of units) {
      if (current.length && (current[0]!.sectionPath !== unit.sectionPath || estimateTokens(joinUnits([...current, unit])) > 800)) {
        drafts.push(makeDraft(document, page.pageNumber, current));
        current = current[0]!.sectionPath === unit.sectionPath ? overlapUnits(current) : [];
      }
      if (current.length && estimateTokens(joinUnits([...current, unit])) > 800) current = [];
      current.push(unit);
    }
    if (current.length) drafts.push(makeDraft(document, page.pageNumber, current));
  }
  return drafts;
}

function paragraphUnits(markdown: string, initialSection: string | null): { units: Unit[]; finalSection: string | null } {
  const units: Unit[] = []; let start = 0, paragraphIndex = 0, sectionPath = initialSection;
  for (const match of markdown.matchAll(/\n{2,}/g)) {
    const end = match.index! + match[0].length;
    if (end > start) { const text = markdown.slice(start, end), heading = headingPath(text); if (heading !== null) sectionPath = heading; units.push({ text, paragraphIndex: paragraphIndex++, segmentIndex: 0, sectionPath }); }
    start = end;
  }
  if (start < markdown.length) { const text = markdown.slice(start), heading = headingPath(text); if (heading !== null) sectionPath = heading; units.push({ text, paragraphIndex, segmentIndex: 0, sectionPath }); }
  return { units: units.filter((unit) => unit.text.length > 0), finalSection: sectionPath };
}

function splitOversizedUnit(unit: Unit): Unit[] {
  if (estimateTokens(unit.text) <= 800) return [unit];
  const parts: Unit[] = []; let remaining = unit.text;
  while (estimateTokens(remaining) > 800) {
    const points = [...remaining]; let low = 1, high = points.length, best = 1;
    while (low <= high) { const middle = Math.floor((low + high) / 2); if (estimateTokens(points.slice(0, middle).join("")) <= 800) { best = middle; low = middle + 1; } else high = middle - 1; }
    const prefix = points.slice(0, best).join(""), sentence = Math.max(prefix.lastIndexOf("。") + 1, prefix.lastIndexOf(".") + 1, prefix.lastIndexOf("!") + 1, prefix.lastIndexOf("?") + 1), whitespace = Math.max(prefix.lastIndexOf(" ") + 1, prefix.lastIndexOf("\n") + 1);
    const cut = sentence > 0 ? sentence : whitespace > 0 ? whitespace : prefix.length;
    parts.push({ ...unit, text: remaining.slice(0, cut), segmentIndex: parts.length });
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push({ ...unit, text: remaining, segmentIndex: parts.length });
  return parts;
}

function overlapUnits(units: Unit[]): Unit[] {
  const overlap: Unit[] = [];
  for (let index = units.length - 1; index >= 0; index--) {
    const candidate = [units[index]!, ...overlap];
    if (estimateTokens(joinUnits(candidate)) > 100) break;
    overlap.unshift(units[index]!);
  }
  return overlap;
}

function joinUnits(units: Unit[]): string { return units.map((unit) => unit.text).join(""); }
function makeDraft(document: ConvertedDocument, pageNumber: number | null, units: Unit[]): KnowledgeChunkDraft {
  const text = joinUnits(units), normalizedText = normalizeChunkText(text), paragraphIndex = units[0]!.paragraphIndex, segmentIndex = units[0]!.segmentIndex;
  return { id: sha256Hex([document.documentId, String(document.indexVersion), pageNumber === null ? "" : String(pageNumber), String(paragraphIndex), String(segmentIndex), normalizedText].join("\0")), documentId: document.documentId, indexVersion: document.indexVersion, text, pageNumber, paragraphIndex, segmentIndex, sectionPath: units[0]!.sectionPath, contentHash: sha256Hex(normalizedText) };
}
function headingPath(text: string): string | null { const match = /^#{1,6}\s+(.+?)(?:\n|$)/u.exec(text); return match?.[1]?.trim() || null; }
export function normalizeChunkText(text: string): string { const lines=text.replace(/\r\n?/g,"\n").split("\n").map((line)=>line.replace(/[ \t]+$/g,""));while(lines.length&&!lines[lines.length-1]!.trim())lines.pop();return lines.join("\n"); }
function isCjk(point: number): boolean { return (point >= 0x3400 && point <= 0x9fff) || (point >= 0xf900 && point <= 0xfaff) || (point >= 0x20000 && point <= 0x3134f); }

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input), bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64, data = new Uint8Array(paddedLength); data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(paddedLength - 4, bitLength >>> 0);
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = new Uint32Array(64); for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const a=w[i-15]!,b=w[i-2]!; const s0=ror(a,7)^ror(a,18)^(a>>>3),s1=ror(b,17)^ror(b,19)^(b>>>10); w[i]=(w[i-16]!+s0+w[i-7]!+s1)>>>0; }
    let [a,b,c,d,e,f,g,hh]=h;
    for(let i=0;i<64;i++){const s1=ror(e!,6)^ror(e!,11)^ror(e!,25),ch=(e!&f!)^(~e!&g!),t1=(hh!+s1+ch+k[i]!+w[i]!)>>>0,s0=ror(a!,2)^ror(a!,13)^ror(a!,22),maj=(a!&b!)^(a!&c!)^(b!&c!),t2=(s0+maj)>>>0;hh=g;g=f;f=e;e=(d!+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    for(const [i,v] of [a,b,c,d,e,f,g,hh].entries())h[i]=(h[i]!+v!)>>>0;
  }
  return h.map((value)=>value.toString(16).padStart(8,"0")).join("");
}
function ror(value:number,bits:number){return (value>>>bits)|(value<<(32-bits));}
