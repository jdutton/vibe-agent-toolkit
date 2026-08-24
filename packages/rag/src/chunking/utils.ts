/**
 * Chunking utilities
 */

import { createHash } from 'node:crypto';

/**
 * Generate content hash for change detection
 *
 * @param content - Content to hash
 * @returns SHA-256 hash of content
 */
export function generateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Generate unique chunk ID
 *
 * @param resourceId - Source resource ID
 * @param chunkIndex - Index of chunk in resource (0-based)
 * @returns Unique chunk ID
 */
export function generateChunkId(resourceId: string, chunkIndex: number): string {
  return `${resourceId}-chunk-${chunkIndex}`;
}

/**
 * Calculate effective target size with padding factor
 *
 * @param targetSize - Target chunk size
 * @param paddingFactor - Padding factor (0.8-1.0)
 * @returns Effective target size
 */
export function calculateEffectiveTarget(
  targetSize: number,
  paddingFactor: number
): number {
  return Math.floor(targetSize * paddingFactor);
}

/**
 * Split text by paragraphs
 *
 * @param text - Text to split
 * @returns Array of paragraphs
 */
export function splitByParagraphs(text: string): string[] {
  // Split by double newlines (paragraph boundaries)
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split text by lines
 *
 * Blank and whitespace-only lines are dropped: they carry no content, and a
 * caller re-joining the pieces with a newline reproduces the source.
 *
 * @param text - Text to split
 * @returns Array of non-blank lines
 */
export function splitByLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Split text by sentences
 *
 * The terminating `.`, `!` or `?` stays with its sentence. These pieces are
 * re-joined on the chunking path, so dropping the terminator would silently
 * delete content from the indexed text.
 *
 * @param text - Text to split
 * @returns Array of sentences, each retaining its terminator
 */
export function splitBySentences(text: string): string[] {
  // Cut at a zero-width position that follows a terminator and is not followed
  // by another, so `...` and `!!` stay whole. Splitting on a boundary rather
  // than matching the sentence keeps every character — the old
  // `match(/[^.!?]+/g)` silently dropped every terminator — and, being pure
  // lookaround with nothing to backtrack into, it is linear in the input.
  return text
    .split(/(?<=[.!?])(?![.!?])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Split text by whitespace-delimited words
 *
 * @param text - Text to split
 * @returns Array of words, with all whitespace runs consumed
 */
export function splitByWords(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word.length > 0);
}
