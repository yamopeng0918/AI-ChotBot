export type OriginalMetadata = { originalName: string; mimeType: string };

export interface KnowledgeObjectStore {
  putOriginal(key: string, body: Blob, metadata: OriginalMetadata): Promise<void>;
  getOriginal(key: string): Promise<R2ObjectBody | null>;
  deleteOriginal(key: string): Promise<void>;
}

export class R2KnowledgeObjectStore implements KnowledgeObjectStore {
  constructor(private readonly bucket: R2Bucket) {}
  async putOriginal(key: string, body: Blob, metadata: OriginalMetadata) {
    await this.bucket.put(key, body.stream(), { httpMetadata: { contentType: metadata.mimeType }, customMetadata: { originalName: metadata.originalName } });
  }
  getOriginal(key: string) { return this.bucket.get(key); }
  async deleteOriginal(key: string) { await this.bucket.delete(key); }
}
