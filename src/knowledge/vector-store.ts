import { sha256Hex } from "./chunker";

export type VectorChunk = { id: string; documentId: string; indexVersion: number };
export type VectorMetadata = { documentId: string; chunkId: string; indexVersion: number };
type VectorRecord = { id: string; values: number[]; metadata: VectorMetadata };
type VectorIndex = {
  upsert(records: VectorRecord[]): Promise<unknown>;
  query(vector: number[], options: { topK: number; returnMetadata: "all"; filter?: Record<string, string | number> }): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
};
type VectorIdResolver = (documentId: string, indexVersion?: number) => Promise<string[]>;

export class KnowledgeVectorStore {
  constructor(private readonly index: VectorIndex, private readonly resolveIds?: VectorIdResolver) {}

  async upsert(chunks: VectorChunk[], vectors: number[][], leaseToken: string): Promise<string[]> {
    if (chunks.length !== vectors.length) throw new RangeError("vector count mismatch");
    const records: VectorRecord[] = chunks.map((chunk, index) => {
      const values = vectors[index]!;
      validateVector(values);
      if (!chunk.id || !chunk.documentId || !Number.isInteger(chunk.indexVersion) || chunk.indexVersion < 1) throw new RangeError("invalid vector metadata");
      const id = vectorIdFor(chunk.documentId, chunk.indexVersion, chunk.id, leaseToken);
      return { id, values, metadata: { documentId: chunk.documentId, chunkId: chunk.id, indexVersion: chunk.indexVersion } };
    });
    for (let offset = 0; offset < records.length; offset += 1_000) await this.index.upsert(records.slice(offset, offset + 1_000));
    return records.map((record) => record.id);
  }

  query(vector: number[], topK: number, filter?: { documentId?: string; indexVersion?: number }): Promise<unknown> {
    validateVector(vector);
    if (!Number.isInteger(topK) || topK < 1) throw new RangeError("invalid topK");
    return this.index.query(vector, { topK, returnMetadata: "all", ...(filter ? { filter } : {}) });
  }

  async deleteIds(ids: string[]): Promise<void> {
    for (const id of ids) if (!/^[0-9a-f]{64}$/.test(id)) throw new RangeError("invalid vector id");
    for (let offset = 0; offset < ids.length; offset += 1_000) await this.index.deleteByIds(ids.slice(offset, offset + 1_000));
  }
  async deleteVersion(documentId: string, indexVersion: number): Promise<void> {
    if (!this.resolveIds) throw new Error("Vector ID resolver unavailable");
    await this.deleteIds(await this.resolveIds(documentId, indexVersion));
  }
  async deleteDocument(documentId: string): Promise<void> {
    if (!this.resolveIds) throw new Error("Vector ID resolver unavailable");
    await this.deleteIds(await this.resolveIds(documentId));
  }
}

export function vectorIdFor(documentId: string, indexVersion: number, chunkId: string, leaseToken: string): string {
  if (!documentId || !chunkId || !leaseToken || !Number.isInteger(indexVersion) || indexVersion < 1) throw new RangeError("invalid vector identity");
  return sha256Hex([documentId, String(indexVersion), chunkId, leaseToken].join("\0"));
}
function validateVector(vector: number[]): void {
  if (!Array.isArray(vector) || vector.length !== 1024) throw new RangeError("vector dimension must be 1024");
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) throw new RangeError("vector values must be finite");
}
