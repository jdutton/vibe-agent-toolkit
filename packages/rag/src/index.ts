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
  IndexProgress,
  ProgressCallback,
  RAGQueryProvider,
  RAGAdminProvider,
  EmbeddingProvider,
  TokenCounter,
} from './interfaces/index.js';

// Schemas (Zod)
export {
  CoreRAGChunkSchema,
  type CoreRAGChunk,
  DefaultRAGMetadataSchema,
  type DefaultRAGMetadata,
  RAGChunkSchema,
  RAGQuerySchema,
  RAGResultSchema,
  RAGStatsSchema,
  IndexResultSchema,
  createCustomRAGChunkSchema,
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

// Chunking
export {
  calculateEffectiveTarget,
  chunkByTokens,
  chunkResource,
  enrichChunks,
  generateChunkId,
  generateContentHash,
  splitByParagraphs,
  splitBySentences,
  type ChunkableResource,
  type ChunkingConfig,
  type ChunkingResult,
  type RawChunk,
} from './chunking/index.js';
