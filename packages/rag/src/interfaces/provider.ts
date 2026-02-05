/**
 * RAG Provider interfaces
 *
 * Defines the contract for RAG (Retrieval-Augmented Generation) providers.
 * Separates read operations (RAGQueryProvider) from write operations (RAGAdminProvider).
 */

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';

import type { RAGChunk } from './chunk.js';

/**
 * Query for RAG database
 */
export interface RAGQuery {
  /** Search query text */
  text: string;

  /** Maximum results to return (default: 10) */
  limit?: number;

  /** Metadata filters */
  filters?: {
    /** Filter by resource ID(s) */
    resourceId?: string | string[];
    /** Filter by tags */
    tags?: string[];
    /** Filter by resource type */
    type?: string;
    /** Filter by heading path (e.g., "Architecture > RAG Design") */
    headingPath?: string;
    /** Filter by date range */
    dateRange?: { start: Date; end: Date };
  };

  /** Hybrid search configuration (vector + keyword) */
  hybridSearch?: {
    enabled: boolean;
    /** Keyword weight (0-1, balance between semantic and keyword) */
    keywordWeight?: number;
  };
}

// RAGChunk is now defined in chunk.ts and imported above
// (exported via re-export from this module for backward compatibility)

/**
 * Result from RAG query
 */
export interface RAGResult {
  /** Matched chunks, sorted by relevance */
  chunks: RAGChunk[];

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
 */
export interface RAGQueryProvider {
  /**
   * Query the RAG database
   */
  query(query: RAGQuery): Promise<RAGResult>;

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
 */
export interface RAGAdminProvider extends RAGQueryProvider {
  /**
   * Index resources into the RAG database
   * - Detects changes via content hash
   * - Deletes old chunks for changed resources
   * - Skips unchanged resources
   */
  indexResources(resources: ResourceMetadata[]): Promise<IndexResult>;

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
