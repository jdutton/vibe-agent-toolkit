/**
 * Chunking types and configuration
 */

import type { TokenCounter } from '../interfaces/token-counter.js';

/**
 * Chunking configuration
 */
export interface ChunkingConfig {
  /** Target chunk size in tokens (ideal) */
  targetChunkSize: number;

  /** Model's maximum token limit (hard limit) */
  modelTokenLimit: number;

  /** Padding factor (0.8-1.0) - safety margin for token estimation */
  paddingFactor: number;

  /** Token counter to use */
  tokenCounter: TokenCounter;

  /** Minimum chunk size in tokens (avoid tiny chunks) */
  minChunkSize?: number;
}

/**
 * Raw chunk before enrichment with metadata
 */
export interface RawChunk {
  content: string;
  headingPath?: string;
  headingLevel?: number;
  startLine?: number;
  endLine?: number;
}

/**
 * Chunking result with statistics
 */
export interface ChunkingResult {
  chunks: RawChunk[];
  stats: {
    totalChunks: number;
    averageTokens: number;
    maxTokens: number;
    minTokens: number;
  };
}
