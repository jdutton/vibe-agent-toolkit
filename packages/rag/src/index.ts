/**
 * @vibe-agent-toolkit/rag
 *
 * Abstract RAG interfaces and shared implementations for vibe-agent-toolkit.
 */

// Interfaces
export type {
  RAGQuery,
  RAGChunk,
  RAGResult,
  RAGStats,
  IndexResult,
  RAGQueryProvider,
  RAGAdminProvider,
  EmbeddingProvider,
  TokenCounter,
} from './interfaces/index.js';
