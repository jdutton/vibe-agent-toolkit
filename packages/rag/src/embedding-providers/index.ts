/**
 * Embedding Provider Implementations
 *
 * Pluggable embedding providers for RAG.
 */

export {
  TransformersEmbeddingProvider,
  type TransformersEmbeddingConfig,
} from './transformers-embedding-provider.js';

export {
  OpenAIEmbeddingProvider,
  type OpenAIEmbeddingConfig,
} from './openai-embedding-provider.js';
