/**
 * RAG Interfaces
 *
 * Core contracts for RAG providers, embedding providers, and token counters.
 */

// Schema-derived types: the Zod schema is the one definition of each shape
export type { IndexResult } from '../schemas/admin.js';
export type { CoreRAGChunk } from '../schemas/core-chunk.js';
export type { DefaultRAGMetadata } from '../schemas/default-metadata.js';
export type { RAGChunk } from './chunk.js';

export type {
  DocumentResult,
  RAGQuery,
  RAGResult,
  RAGStats,
  IndexProgress,
  ProgressCallback,
  RAGQueryProvider,
  RAGAdminProvider,
} from './provider.js';

export type { EmbeddingProvider } from './embedding.js';
export type { TokenCounter } from './token-counter.js';
