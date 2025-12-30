/**
 * Chunking utilities
 *
 * Hybrid chunking strategy: heading-based + token-aware.
 */

export { chunkByTokens } from './chunk-by-tokens.js';
export { chunkResource, enrichChunks, type ChunkableResource } from './chunk-resource.js';
export type { ChunkingConfig, RawChunk, ChunkingResult } from './types.js';
export {
  calculateEffectiveTarget,
  generateChunkId,
  generateContentHash,
  splitByParagraphs,
  splitBySentences,
} from './utils.js';
