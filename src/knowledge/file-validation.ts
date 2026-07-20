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
    const pointer = /\bstartxref\s+(\d+)\s+%%EOF\s*$/.exec(body);
    if (!/^%PDF-1\.[0-9][\r\n]/.test(body) || !/\b\d+\s+\d+\s+obj\b[\s\S]*?\bendobj\b/.test(body) || !pointer) throw new KnowledgeFileError("invalid_file");
    const offset = Number(pointer[1]); const target = body.slice(offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= body.length || !(target.startsWith("xref") || /^\d+\s+\d+\s+obj\b[\s\S]{0,1024}?\/Type\s*\/XRef\b/.test(target))) throw new KnowledgeFileError("invalid_file");
    return { kind: "pdf", mimeType: file.type, extension: ".pdf" };
  }
  if (file.type === DOCX_MIME) {
    if (starts(head, [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])) {
      validateEncryptedCfb(new Uint8Array(await file.arrayBuffer())); throw new KnowledgeFileError("encrypted_document");
    }
    if (!starts(head, [0x50,0x4b,0x03,0x04])) throw new KnowledgeFileError("invalid_file");
    await validateDocxZip(new Uint8Array(await file.arrayBuffer()));
    return { kind: "docx", mimeType: file.type, extension: ".docx" };
  }
  if (file.type === "image/jpeg") {
    if (!starts(head, [0xff,0xd8,0xff])) throw new KnowledgeFileError("invalid_file");
    validateJpeg(new Uint8Array(await file.arrayBuffer()));
    return { kind: "jpeg", mimeType: file.type, extension: ".jpg" };
  }
  if (file.type === "image/png") {
    if (!starts(head, [137,80,78,71,13,10,26,10])) throw new KnowledgeFileError("invalid_file");
    await validatePng(new Uint8Array(await file.arrayBuffer()));
    return { kind: "png", mimeType: file.type, extension: ".png" };
  }
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await file.arrayBuffer()); }
  catch { throw new KnowledgeFileError("invalid_file"); }
  return { kind: "text", mimeType: file.type, extension: ".txt" };
}

function starts(actual: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => actual[index] === value);
}

function validateJpeg(bytes: Uint8Array): void {
  let offset = 2, hasSof = false, hasSos = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new KnowledgeFileError("invalid_file");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) throw new KnowledgeFileError("invalid_file");
    if (marker === 0xd9) { if (offset !== bytes.length || !hasSof || !hasSos) throw new KnowledgeFileError("invalid_file"); return; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0x00 || offset + 2 > bytes.length) throw new KnowledgeFileError("invalid_file");
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) throw new KnowledgeFileError("invalid_file");
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4,0xc8,0xcc].includes(marker)) hasSof = true;
    offset += length;
    if (marker === 0xda) {
      hasSos = true;
      while (offset < bytes.length - 1) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
    }
  }
  throw new KnowledgeFileError("invalid_file");
}

async function validatePng(bytes: Uint8Array): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 8; let index = 0, ended = false, width=0,height=0,depth=0,color=0,interlace=0; const idat:Uint8Array[]=[];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new KnowledgeFileError("invalid_file");
    const length = view.getUint32(offset); const type = new TextDecoder("ascii").decode(bytes.slice(offset + 4, offset + 8));
    const next = offset + 12 + length; if (!/^[A-Za-z]{4}$/.test(type) || next > bytes.length) throw new KnowledgeFileError("invalid_file");
    if (crc32(bytes.slice(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) throw new KnowledgeFileError("invalid_file");
    if (index++ === 0) { width=view.getUint32(offset+8);height=view.getUint32(offset+12);depth=bytes[offset+16]!;color=bytes[offset+17]!;interlace=bytes[offset+20]!; if(type!=="IHDR"||length!==13||!width||!height||!validPngMode(depth,color)||bytes[offset+18]!==0||bytes[offset+19]!==0||![0,1].includes(interlace))throw new KnowledgeFileError("invalid_file"); }
    if (type === "IHDR" && index !== 1) throw new KnowledgeFileError("invalid_file");
    if (type === "IDAT") { if (!length) throw new KnowledgeFileError("invalid_file"); idat.push(bytes.slice(offset+8,offset+8+length)); }
    if (type === "IEND") { if (length !== 0 || next !== bytes.length || idat.length === 0 || ended) throw new KnowledgeFileError("invalid_file"); ended = true; break; }
    offset = next;
  }
  if(!ended)throw new KnowledgeFileError("invalid_file");const expected=pngExpected(width,height,depth,color,interlace);if(expected>MAX_BYTES)throw new KnowledgeFileError("invalid_file");const raw=await inflate(joinBytes(idat),"deflate",expected);if(raw.length!==expected)throw new KnowledgeFileError("invalid_file");let p=0;for(const row of pngRows(width,height,depth,color,interlace)){const filter=raw[p];if(filter===undefined||filter>4)throw new KnowledgeFileError("invalid_file");p+=row;}
}

async function validateDocxZip(bytes: Uint8Array): Promise<void> {
  if (bytes.length < 22) throw new KnowledgeFileError("invalid_file"); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1; for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i,true)===0x06054b50){eocd=i;break;}
  if (eocd < 0 || eocd + 22 + view.getUint16(eocd+20,true) !== bytes.length) throw new KnowledgeFileError("invalid_file");
  const count=view.getUint16(eocd+10,true), centralSize=view.getUint32(eocd+12,true), centralOffset=view.getUint32(eocd+16,true); if (!count || centralOffset+centralSize!==eocd) throw new KnowledgeFileError("invalid_file");
  const required = new Map<string,string>([["[Content_Types].xml","Types"],["word/document.xml","document"]]); let offset=centralOffset;
  for(let i=0;i<count;i++){
    if(offset+46>eocd||view.getUint32(offset,true)!==0x02014b50)throw new KnowledgeFileError("invalid_file"); const flags=view.getUint16(offset+8,true);if(flags&1)throw new KnowledgeFileError("encrypted_document");
    const method=view.getUint16(offset+10,true), compressed=view.getUint32(offset+20,true), size=view.getUint32(offset+24,true), nl=view.getUint16(offset+28,true),el=view.getUint16(offset+30,true),cl=view.getUint16(offset+32,true),local=view.getUint32(offset+42,true);const name=decode(bytes.slice(offset+46,offset+46+nl));
    if(local+30>centralOffset||view.getUint32(local,true)!==0x04034b50||view.getUint16(local+6,true)!==flags||view.getUint16(local+8,true)!==method)throw new KnowledgeFileError("invalid_file");const lnl=view.getUint16(local+26,true),lel=view.getUint16(local+28,true);if(decode(bytes.slice(local+30,local+30+lnl))!==name)throw new KnowledgeFileError("invalid_file");const start=local+30+lnl+lel;if(!size||size>MAX_BYTES||start+compressed>centralOffset)throw new KnowledgeFileError("invalid_file");
    if(required.has(name)){const raw=bytes.slice(start,start+compressed);const data=method===0?raw:await inflate(raw,"deflate-raw",size);if(data.length!==size||crc32(data)!==view.getUint32(offset+16,true))throw new KnowledgeFileError("invalid_file");const xml=decode(data).replace(/^\uFEFF?\s*(?:<\?[\s\S]*?\?>\s*)?(?:(?:<!--[\s\S]*?-->)\s*)*/,"");if(!new RegExp(`^<[^>]*${required.get(name)}\\b`).test(xml))throw new KnowledgeFileError("invalid_file");required.delete(name);}
    offset+=46+nl+el+cl;
  }
  if(offset!==eocd||required.size)throw new KnowledgeFileError("invalid_file");
}
async function inflate(data:Uint8Array,format:"deflate"|"deflate-raw",limit:number){try{const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream(format as never)).getReader();const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>Math.min(limit,MAX_BYTES)){await reader.cancel();throw new KnowledgeFileError("invalid_file");}chunks.push(value);}return joinBytes(chunks);}catch(error){if(error instanceof KnowledgeFileError)throw error;throw new KnowledgeFileError("invalid_file");}}
function decode(data:Uint8Array){try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(data);}catch{throw new KnowledgeFileError("invalid_file");}}
function crc32(data:Uint8Array){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function joinBytes(values:Uint8Array[]){const out=new Uint8Array(values.reduce((s,v)=>s+v.length,0));let o=0;for(const v of values){out.set(v,o);o+=v.length;}return out;}
function validPngMode(d:number,c:number){return(c===0&&[1,2,4,8,16].includes(d))||(c===2&&[8,16].includes(d))||(c===3&&[1,2,4,8].includes(d))||(c===4&&[8,16].includes(d))||(c===6&&[8,16].includes(d));}
function pngRows(w:number,h:number,d:number,c:number,i:number){const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[c]!;const row=(x:number)=>1+Math.ceil(x*channels*d/8);if(!i)return Array(h).fill(row(w));const passes=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];const rows:number[]=[];for(const [sx,sy,dx,dy] of passes){const pw=w>sx! ? Math.ceil((w-sx!)/dx!) : 0, ph=h>sy! ? Math.ceil((h-sy!)/dy!) : 0;for(let y=0;y<ph;y++)rows.push(row(pw));}return rows;}
function pngExpected(w:number,h:number,d:number,c:number,i:number){return pngRows(w,h,d,c,i).reduce((a,b)=>a+b,0);}
function validateEncryptedCfb(bytes:Uint8Array){if(bytes.length<1024)throw new KnowledgeFileError("invalid_file");const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(v.getUint16(26,true)!==3||v.getUint16(28,true)!==0xfffe||v.getUint16(30,true)!==9||v.getUint16(32,true)!==6)throw new KnowledgeFileError("invalid_file");const sector=v.getUint32(48,true),start=512+sector*512;if(start<512||start+512>bytes.length)throw new KnowledgeFileError("invalid_file");const names=new Set<string>();for(let o=start;o+128<=start+512;o+=128){const len=v.getUint16(o+64,true);if(len>=2&&len<=64&&len%2===0)names.add(new TextDecoder("utf-16le").decode(bytes.slice(o,o+len-2)));}if(!names.has("EncryptionInfo")||!names.has("EncryptedPackage"))throw new KnowledgeFileError("invalid_file");}
