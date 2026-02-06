/**
 * Token-aware chunking
 *
 * Splits text by token count, respecting paragraph boundaries.
 */

import type { ChunkingConfig, RawChunk } from './types.js';
import { calculateEffectiveTarget, splitByParagraphs } from './utils.js';

/**
 * Chunk a large paragraph by lines
 *
 * When a single paragraph exceeds the effective target, split it into smaller chunks by lines.
 *
 * @param paragraph - The large paragraph to split
 * @param text - Original text for line number tracking
 * @param textPosition - Current position in original text
 * @param baseStartLine - Base line number for this section
 * @param config - Chunking configuration
 * @param metadata - Metadata to attach to chunks
 * @returns Array of raw chunks from this paragraph
 */
function chunkLargeParagraphByLines(
  paragraph: string,
  text: string,
  textPosition: number,
  baseStartLine: number,
  config: ChunkingConfig,
  metadata?: { headingPath?: string; headingLevel?: number; startLine?: number; endLine?: number }
): RawChunk[] {
  const { tokenCounter } = config;
  const effectiveTarget = calculateEffectiveTarget(config.targetChunkSize, config.paddingFactor);
  const chunks: RawChunk[] = [];

  const lines = paragraph.split('\n');
  let lineChunk = '';
  let lineChunkTokens = 0;
  let lineChunkStartPos = textPosition;

  for (const line of lines) {
    const lineTokens = tokenCounter.count(line);

    // If adding this line would exceed target, save current chunk
    if (lineChunkTokens > 0 && lineChunkTokens + lineTokens > effectiveTarget) {
      chunks.push(createChunkWithLineNumbers(lineChunk, text, lineChunkStartPos, baseStartLine, metadata));

      lineChunk = '';
      lineChunkTokens = 0;
      lineChunkStartPos = text.indexOf(line, lineChunkStartPos + lineChunk.length);
    }

    // Add line to current chunk
    lineChunk += (lineChunk.length > 0 ? '\n' : '') + line;
    lineChunkTokens += lineTokens;
  }

  // Add final line chunk
  if (lineChunk.trim().length > 0) {
    chunks.push(createChunkWithLineNumbers(lineChunk, text, lineChunkStartPos, baseStartLine, metadata));
  }

  return chunks;
}

/**
 * Create a chunk with line number tracking
 *
 * @param content - Chunk content
 * @param text - Original text for line tracking
 * @param chunkStartPosition - Character position where chunk starts
 * @param baseStartLine - Base line number for section
 * @param metadata - Metadata to attach
 * @returns Raw chunk with line numbers
 */
function createChunkWithLineNumbers(
  content: string,
  text: string,
  chunkStartPosition: number,
  baseStartLine: number,
  metadata?: { headingPath?: string; headingLevel?: number; startLine?: number; endLine?: number }
): RawChunk {
  const textUpToChunkStart = text.substring(0, chunkStartPosition);
  const linesBeforeChunk = (textUpToChunkStart.match(/\n/g) ?? []).length;
  const chunkStartLine = baseStartLine + linesBeforeChunk;

  const linesInChunk = content.trim().split('\n').length;
  const chunkEndLine = chunkStartLine + linesInChunk - 1;

  return {
    content: content.trim(),
    ...metadata,
    startLine: chunkStartLine,
    endLine: chunkEndLine,
  };
}

/**
 * Chunk text by token count
 *
 * Splits text when it exceeds the effective target size (targetChunkSize * paddingFactor).
 * Respects paragraph boundaries when possible, falls back to line splitting for large paragraphs.
 *
 * Complexity note: This function handles multiple chunking strategies (early return, paragraph-level,
 * line-level fallback) with position tracking for accurate line numbers. The core loop requires
 * coordinated state management that doesn't simplify well into smaller functions without losing
 * clarity. Helper functions already extracted for line-level chunking and chunk creation.
 *
 * @param text - Text to chunk
 * @param config - Chunking configuration
 * @param metadata - Optional metadata to attach to chunks
 * @returns Array of raw chunks
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export function chunkByTokens(
  text: string,
  config: ChunkingConfig,
  metadata?: { headingPath?: string; headingLevel?: number; startLine?: number; endLine?: number }
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

  // Track line numbers for chunks
  const baseStartLine = metadata?.startLine ?? 1;

  // Track position in original text for accurate line number calculation
  let textPosition = 0;
  let chunkStartPosition = 0; // Character position where current chunk starts

  for (const paragraph of paragraphs) {
    const paragraphTokens = tokenCounter.count(paragraph);

    // Check if paragraph itself exceeds model limit
    if (paragraphTokens > modelTokenLimit) {
      throw new Error(
        `Paragraph exceeds model token limit (${paragraphTokens} > ${modelTokenLimit}). ` +
          'Consider splitting by sentences or reducing content.'
      );
    }

    // Find this paragraph in the original text
    const paragraphIndex = text.indexOf(paragraph.trim(), textPosition);
    const actualParagraphIndex = paragraphIndex === -1 ? textPosition : paragraphIndex;

    // If paragraph itself exceeds effective target, split it by lines
    if (paragraphTokens > effectiveTarget) {
      const paragraphChunks = chunkLargeParagraphByLines(
        paragraph,
        text,
        actualParagraphIndex,
        baseStartLine,
        config,
        metadata
      );
      chunks.push(...paragraphChunks);
      textPosition = actualParagraphIndex + paragraph.length;
      continue;
    }

    // If adding this paragraph would exceed target, save current chunk and start new one
    const wouldExceedTarget = currentTokens > 0 && currentTokens + paragraphTokens > effectiveTarget;
    if (wouldExceedTarget) {
      chunks.push(createChunkWithLineNumbers(currentChunk, text, chunkStartPosition, baseStartLine, metadata));
      currentChunk = '';
      currentTokens = 0;
    }

    // Mark chunk start position when starting new chunk
    const isNewChunk = currentChunk.length === 0;
    if (isNewChunk) {
      chunkStartPosition = actualParagraphIndex;
    }

    // Add paragraph to current chunk
    currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + paragraph;
    currentTokens += paragraphTokens;
    textPosition = actualParagraphIndex + paragraph.length;
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(createChunkWithLineNumbers(currentChunk, text, chunkStartPosition, baseStartLine, metadata));
  }

  return chunks;
}
