export type DocumentStatus = "pending" | "processing" | "ready" | "failed" | "deleting";
export type IngestionOperation = "ingest" | "reindex" | "delete";
export type IngestionJobStatus = "pending" | "processing" | "completed" | "failed";

export type KnowledgeDocument = {
  id: string;
  sourceType: "file" | "url";
  displayName: string;
  sourceUrl: string | null;
  r2Key: string | null;
  activeVersion: number | null;
  contentHash: string | null;
  pageCount: number | null;
  errorCode: string | null;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeChunk = {
  id: string;
  documentId: string;
  indexVersion: number;
  text: string;
  pageNumber: number | null;
  sectionPath: string | null;
  paragraphIndex: number | null;
  segmentIndex: number;
  vectorId: string;
  contentHash: string;
  createdAt: string;
};

export type IngestionJob = {
  id: string;
  documentId: string;
  operation: IngestionOperation;
  status: IngestionJobStatus;
  attemptCount: number;
  leaseToken: string | null;
  leaseUntil: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IngestionJobMessage = { jobId: string; documentId: string; kind: IngestionOperation };

export type KnowledgeEvidence = {
  id: string;
  sourceType: "knowledge" | "web";
  title: string;
  url: string | null;
  text: string;
  pageNumber: number | null;
  sectionPath: string | null;
  paragraphIndex: number | null;
  segmentIndex?: number | null;
  retrievedAt: string;
  score: number;
};
