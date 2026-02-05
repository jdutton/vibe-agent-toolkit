/**
 * RAGChunk interface
 *
 * Backward-compatible alias combining CoreRAGChunk + DefaultRAGMetadata.
 * Existing code using RAGChunk continues to work unchanged.
 */

import type { CoreRAGChunk } from '../schemas/core-chunk.js';
import type { DefaultRAGMetadata } from '../schemas/default-metadata.js';

/**
 * RAGChunk
 *
 * Standard RAG chunk type with default metadata.
 * This is the backward-compatible type that existing code uses.
 */
export type RAGChunk = CoreRAGChunk & DefaultRAGMetadata;
