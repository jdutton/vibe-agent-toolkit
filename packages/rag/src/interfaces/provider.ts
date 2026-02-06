/**
 * RAG Provider interfaces
 *
 * Defines the contract for RAG (Retrieval-Augmented Generation) providers.
 * Separates read operations (RAGQueryProvider) from write operations (RAGAdminProvider).
 */

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';

import type { CoreRAGChunk } from '../schemas/core-chunk.js';
import type { DefaultRAGMetadata } from '../schemas/default-metadata.js';

/**
 * Query for RAG database
 *
 * Generic over metadata type for type-safe filtering.
 */
export interface RAGQuery<TMetadata extends Record<string, unknown> = DefaultRAGMetadata> {
  /** Search query text */
  text: string;

  /** Maximum results to return (default: 10) */
  limit?: number;

  /** Filters */
  filters?: {
    /** Filter by resource ID(s) */
    resourceId?: string | string[];
    /** Filter by date range */
    dateRange?: { start: Date; end: Date };

    /** Metadata filters (type-safe based on TMetadata) */
    metadata?: Partial<TMetadata>;
  };

  /** Hybrid search configuration (vector + keyword) */
  hybridSearch?: {
    enabled: boolean;
    /** Keyword weight (0-1, balance between semantic and keyword) */
    keywordWeight?: number;
  };
}

/**
 * Chunk returned from RAG query
 * Note: Full schema defined in schemas/chunk.ts
 *
 * Re-exported here for convenience.
 */
export type { RAGChunk } from './chunk.js';

/**
 * Result from RAG query
 *
 * Generic over metadata type - chunks have type CoreRAGChunk & TMetadata.
 */
export interface RAGResult<TMetadata extends Record<string, unknown> = DefaultRAGMetadata> {
  /** Matched chunks, sorted by relevance */
  chunks: Array<CoreRAGChunk & TMetadata>;

  /** Search statistics */
  stats: {
    totalMatches: number;
    searchDurationMs: number;
    embedding?: {
      model: string;
      tokensUsed?: number;
    };
  };
}

/**
 * RAG database statistics
 */
export interface RAGStats {
  totalChunks: number;
  totalResources: number;
  dbSizeBytes: number;
  embeddingModel: string;
  lastIndexed: Date;
}

/**
 * Progress update during indexing operation
 */
export interface IndexProgress {
  /** Current resource being processed (1-indexed) */
  current: number;
  /** Total resources to process */
  total: number;
  /** Resources indexed so far */
  resourcesIndexed: number;
  /** Resources skipped so far */
  resourcesSkipped: number;
  /** Resources updated so far */
  resourcesUpdated: number;
  /** Chunks created so far */
  chunksCreated: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Estimated time remaining in milliseconds (null if not enough data) */
  estimatedRemainingMs: number | null;
  /** Current resource ID */
  resourceId: string;
  /** Errors encountered so far */
  errors: Array<{ resourceId: string; error: string }>;
}

/**
 * Progress callback for indexing operations
 */
export type ProgressCallback = (progress: IndexProgress) => void;

/**
 * Result from indexing operation
 */
export interface IndexResult {
  resourcesIndexed: number;
  resourcesSkipped: number;
  resourcesUpdated: number;
  chunksCreated: number;
  chunksDeleted: number;
  durationMs: number;
  errors?: Array<{ resourceId: string; error: string }>;
}

/**
 * RAG Query Provider (read-only)
 *
 * This is what agents use at runtime to query the RAG database.
 * Generic over metadata type for type-safe queries and results.
 */
export interface RAGQueryProvider<TMetadata extends Record<string, unknown> = DefaultRAGMetadata> {
  /**
   * Query the RAG database
   */
  query(query: RAGQuery<TMetadata>): Promise<RAGResult<TMetadata>>;

  /**
   * Get database statistics
   */
  getStats(): Promise<RAGStats>;
}

/**
 * RAG Admin Provider (read/write)
 *
 * This is what build tools and admin processes use to index/update the RAG database.
 * Extends RAGQueryProvider to include write operations.
 * Generic over metadata type for type-safe operations.
 */
export interface RAGAdminProvider<TMetadata extends Record<string, unknown> = DefaultRAGMetadata>
  extends RAGQueryProvider<TMetadata> {
  /**
   * Index resources into the RAG database
   * - Detects changes via content hash
   * - Deletes old chunks for changed resources
   * - Skips unchanged resources
   *
   * @param resources - Resources to index
   * @param onProgress - Optional callback for progress updates (called after each resource)
   */
  indexResources(resources: ResourceMetadata[], onProgress?: ProgressCallback): Promise<IndexResult>;

  /**
   * Update a specific resource
   */
  updateResource(resourceId: string): Promise<void>;

  /**
   * Delete a specific resource and all its chunks
   */
  deleteResource(resourceId: string): Promise<void>;

  /**
   * Clear the entire database
   */
  clear(): Promise<void>;

  /**
   * Close database connection
   */
  close(): Promise<void>;
}
