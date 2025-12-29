/**
 * Token-aware chunking
 *
 * Splits text by token count, respecting paragraph boundaries.
 */

import type { ChunkingConfig, RawChunk } from './types.js';
import { calculateEffectiveTarget, splitByParagraphs } from './utils.js';

/**
 * Chunk text by token count
 *
 * Splits text when it exceeds the effective target size (targetChunkSize * paddingFactor).
 * Respects paragraph boundaries when possible, falls back to sentence splitting.
 *
 * @param text - Text to chunk
 * @param config - Chunking configuration
 * @param metadata - Optional metadata to attach to chunks
 * @returns Array of raw chunks
 */
export function chunkByTokens(
  text: string,
  config: ChunkingConfig,
  metadata?: { headingPath?: string; headingLevel?: number }
): RawChunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const { targetChunkSize, modelTokenLimit, paddingFactor, tokenCounter } = config;
  const effectiveTarget = calculateEffectiveTarget(targetChunkSize, paddingFactor);

  // Check if entire text fits
  const totalTokens = tokenCounter.count(text);
  if (totalTokens <= effectiveTarget) {
    return [
      {
        content: text,
        ...metadata,
      },
    ];
  }

  // Split by paragraphs first
  const paragraphs = splitByParagraphs(text);
  const chunks: RawChunk[] = [];
  let currentChunk = '';
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = tokenCounter.count(paragraph);

    // Check if paragraph itself exceeds model limit
    if (paragraphTokens > modelTokenLimit) {
      throw new Error(
        `Paragraph exceeds model token limit (${paragraphTokens} > ${modelTokenLimit}). ` +
          'Consider splitting by sentences or reducing content.'
      );
    }

    // If adding this paragraph would exceed target, start new chunk
    if (currentTokens > 0 && currentTokens + paragraphTokens > effectiveTarget) {
      chunks.push({
        content: currentChunk.trim(),
        ...metadata,
      });
      currentChunk = '';
      currentTokens = 0;
    }

    // Add paragraph to current chunk
    currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + paragraph;
    currentTokens += paragraphTokens;
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      ...metadata,
    });
  }

  return chunks;
}
