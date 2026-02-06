/**
 * RAG Interfaces
 *
 * Core contracts for RAG providers, embedding providers, and token counters.
 */

// Re-export schema types for backward compatibility
export type { CoreRAGChunk } from '../schemas/core-chunk.js';
export type { DefaultRAGMetadata } from '../schemas/default-metadata.js';
export type { RAGChunk } from './chunk.js';

export type {
  RAGQuery,
  RAGResult,
  RAGStats,
  IndexResult,
  IndexProgress,
  ProgressCallback,
  RAGQueryProvider,
  RAGAdminProvider,
} from './provider.js';

export type { EmbeddingProvider } from './embedding.js';
export type { TokenCounter } from './token-counter.js';
