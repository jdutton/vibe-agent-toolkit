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
 * Split text by sentences
 *
 * @param text - Text to split
 * @returns Array of sentences
 */
export function splitBySentences(text: string): string[] {
  // Simple sentence splitting (handles . ! ?)
  // Match sentence boundaries and capture the sentences
  const matches = text.match(/[^.!?]+/g);
  if (!matches) {
    return [];
  }
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}
