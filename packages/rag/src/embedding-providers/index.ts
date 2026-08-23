/**
 * Embedding Provider Implementations
 *
 * Pluggable embedding providers for RAG.
 */

export {
  OpenAIEmbeddingProvider,
  type OpenAIEmbeddingConfig,
} from './openai-embedding-provider.js';

export {
  OnnxEmbeddingProvider,
  type OnnxEmbeddingConfig,
  type TruncationEvent,
  type TruncationStats,
} from './onnx-embedding-provider.js';
