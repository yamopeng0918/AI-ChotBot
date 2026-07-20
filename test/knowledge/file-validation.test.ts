import { describe, expect, test } from "vitest";
import { validateKnowledgeFile } from "../../src/knowledge/file-validation";

const validDocx = zipEntries([["[Content_Types].xml", "\uFEFF<?xml version=\"1.0\"?>\n<!-- office -->\n<Types></Types>"], ["word/document.xml", "<?xml version=\"1.0\"?>\n<w:document></w:document>"]]);

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
    const prefix = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nxref\n"), tail = new TextEncoder().encode(`\nstartxref\n${"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".length}\n%%EOF`);
    const file = new File([prefix, new Uint8Array(10 * 1024 * 1024 - prefix.length - tail.length), tail], "a.pdf", { type: "application/pdf" });
    await expect(validateKnowledgeFile(file)).resolves.toMatchObject({ kind: "pdf" });
  });

  test.each([
    [new File([], "empty.txt", { type: "text/plain" }), "invalid_file"],
    [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.txt", { type: "text/plain" }), "file_too_large"],
    [new File(["MZ executable"], "fake.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-"], "short.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-1.7\nstartxref\n1\n%%EOF"], "shell.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n1\n%%EOF"], "no-xref.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\nxref\nstartxref\n999\n%%EOF"], "bad-pointer.pdf", { type: "application/pdf" }), "invalid_file"],
    [new File(["%PDF-1.7\n/Encrypt 1 0 R"], "secret.pdf", { type: "application/pdf" }), "encrypted_document"],
    [new File([new Uint8Array([0x50,0x4b,0x03,0x04])], "bad.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File([zipEntries([["[Content_Types].xml", "<Types/>"] , ["word/document.xml", "<w:document/>"]], 1)], "encrypted.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "encrypted_document"],
    [new File([new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0,0,0])], "magic.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File([encryptedCfb()], "protected.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "encrypted_document"],
    [new File([new Uint8Array([0xff,0xd8,0xff])], "short.jpg", { type: "image/jpeg" }), "invalid_file"],
    [new File([new Uint8Array([0xff,0xd8,0xff,0xe0,0,2,0xff,0xd9])], "shell.jpg", { type: "image/jpeg" }), "invalid_file"],
    [new File([new Uint8Array([137,80,78,71,13,10,26,10])], "short.png", { type: "image/png" }), "invalid_file"],
    [new File([join(new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk("IHDR",new Uint8Array([0,0,0,1,0,0,0,1,8,2,0,0,0])),pngChunk("IEND",new Uint8Array()))], "no-idat.png", { type: "image/png" }), "invalid_file"],
    [new File([corruptPngCrc()], "bad-crc.png", { type: "image/png" }), "invalid_file"],
    [new File([new Uint8Array([0x50,0x4b,0x03,0x04,...new TextEncoder().encode("[Content_Types].xml word/document.xml")])], "spoof.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "invalid_file"],
    [new File(["hello"], "a.exe", { type: "application/octet-stream" }), "unsupported_type"],
  ])("rejects invalid input with a stable code", async (file, code) => {
    await expect(validateKnowledgeFile(file)).rejects.toMatchObject({ code });
  });
});

test("rejects DOCX declared uncompressed content above the bounded limit", async () => {
  const value=zipEntries([["[Content_Types].xml","<Types/>"] ,["word/document.xml","<w:document/>"]]);const view=new DataView(value.buffer);let central=0;for(let i=0;i<value.length-4;i++)if(view.getUint32(i,true)===0x02014b50){central=i;break;}view.setUint32(central+24,10*1024*1024+1,true);
  await expect(validateKnowledgeFile(new File([value],"bomb.docx",{type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}))).rejects.toMatchObject({code:"invalid_file"});
});

test.each([[new Uint8Array([1,2,3]),8,2],[null,1,2],[null,8,2]])("rejects invalid PNG zlib, illegal depth/color, or scanline filter", async (compressed,depth,color) => {
  const data=compressed??await zlib(new Uint8Array([5,0,0,0]));const png=pngWith(data,depth,color);
  await expect(validateKnowledgeFile(new File([png],"bad.png",{type:"image/png"}))).rejects.toMatchObject({code:"invalid_file"});
});

function zipEntries(entries: Array<[string,string]>, flags = 0): Uint8Array {
  const locals: Uint8Array[] = []; const centrals: Uint8Array[] = []; let localOffset = 0;
  for (const [name, body] of entries) { const n = new TextEncoder().encode(name), data = new TextEncoder().encode(body), crc = crc32(data);
    const local = new Uint8Array(30+n.length+data.length), lv = new DataView(local.buffer); local.set([0x50,0x4b,0x03,0x04,20,0]); lv.setUint16(6,flags,true); lv.setUint32(14,crc,true); lv.setUint32(18,data.length,true); lv.setUint32(22,data.length,true); lv.setUint16(26,n.length,true); local.set(n,30); local.set(data,30+n.length); locals.push(local);
    const central = new Uint8Array(46+n.length), cv = new DataView(central.buffer); central.set([0x50,0x4b,0x01,0x02,20,0,20,0]); cv.setUint16(8,flags,true); cv.setUint32(16,crc,true); cv.setUint32(20,data.length,true); cv.setUint32(24,data.length,true); cv.setUint16(28,n.length,true); cv.setUint32(42,localOffset,true); central.set(n,46); centrals.push(central); localOffset += local.length; }
  const centralSize=centrals.reduce((s,v)=>s+v.length,0), out=new Uint8Array(localOffset+centralSize+22); let o=0; for(const v of [...locals,...centrals]){out.set(v,o);o+=v.length;} const dv=new DataView(out.buffer); out.set([0x50,0x4b,0x05,0x06],o); dv.setUint16(o+8,entries.length,true); dv.setUint16(o+10,entries.length,true); dv.setUint32(o+12,centralSize,true); dv.setUint32(o+16,localOffset,true); return out;
}
function validPdf() { const base="%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"; return `${base}xref\n0 2\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R >>\nstartxref\n${base.length}\n%%EOF`; }
function validJpeg() { return new Uint8Array([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0x12,0xff,0,0x34,0xff,0xd0,0x56,0xff,0xd9]); }
function validPng() {
  const sig=new Uint8Array([137,80,78,71,13,10,26,10]); return join(sig,pngChunk("IHDR",new Uint8Array([0,0,0,1,0,0,0,1,8,2,0,0,0])),pngChunk("IDAT",new Uint8Array([0x78,0x9c,0x63,0xf8,0xcf,0xc0,0,0,0x03,0x01,0x01,0])),pngChunk("IEND",new Uint8Array()));
}
function pngWith(data:Uint8Array,depth:number,color:number){const sig=new Uint8Array([137,80,78,71,13,10,26,10]);return join(sig,pngChunk("IHDR",new Uint8Array([0,0,0,1,0,0,0,1,depth,color,0,0,0])),pngChunk("IDAT",data),pngChunk("IEND",new Uint8Array()));}
async function zlib(data:Uint8Array){const stream=new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));return new Uint8Array(await new Response(stream).arrayBuffer());}
function corruptPngCrc(){const value=validPng();value[32]=value[32]!^1;return value;}
function pngChunk(type:string,data:Uint8Array){const t=new TextEncoder().encode(type),v=new Uint8Array(12+data.length),d=new DataView(v.buffer);d.setUint32(0,data.length);v.set(t,4);v.set(data,8);d.setUint32(8+data.length,crc32(join(t,data)));return v;}
function join(...values:Uint8Array[]){const out=new Uint8Array(values.reduce((s,v)=>s+v.length,0));let o=0;for(const v of values){out.set(v,o);o+=v.length;}return out;}
function crc32(data:Uint8Array){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function encryptedCfb(){const out=new Uint8Array(1024),v=new DataView(out.buffer);out.set([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);v.setUint16(24,0x3e,true);v.setUint16(26,3,true);v.setUint16(28,0xfffe,true);v.setUint16(30,9,true);v.setUint16(32,6,true);v.setUint32(48,0,true);for(const [i,n] of ["EncryptionInfo","EncryptedPackage"].entries()){const encoded=new TextEncoder().encode(n.split("").join("\0")+"\0\0");out.set(encoded,512+i*128);v.setUint16(512+i*128+64,(n.length+1)*2,true);}return out;}
