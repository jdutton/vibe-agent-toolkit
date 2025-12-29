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

// Schemas (Zod)
export {
  RAGChunkSchema,
  RAGQuerySchema,
  RAGResultSchema,
  RAGStatsSchema,
  IndexResultSchema,
} from './schemas/index.js';

// JSON Schemas
export {
  RAGChunkJsonSchema,
  RAGQueryJsonSchema,
  RAGResultJsonSchema,
  RAGStatsJsonSchema,
  IndexResultJsonSchema,
  jsonSchemas,
} from './schemas/json-schema.js';

// Token Counters
export { ApproximateTokenCounter, FastTokenCounter } from './token-counters/index.js';

// Embedding Providers
export {
  OpenAIEmbeddingProvider,
  TransformersEmbeddingProvider,
  type OpenAIEmbeddingConfig,
  type TransformersEmbeddingConfig,
} from './embedding-providers/index.js';
