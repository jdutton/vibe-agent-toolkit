/**
 * Resource chunking
 *
 * Chunks ResourceMetadata using hybrid heading-based + token-aware strategy.
 */

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';

import type { RAGChunk } from '../schemas/chunk.js';

import { chunkByTokens } from './chunk-by-tokens.js';
import type { ChunkingConfig, ChunkingResult, RawChunk } from './types.js';
import { generateChunkId, generateContentHash } from './utils.js';

/**
 * Extended resource metadata for chunking
 *
 * Extends ResourceMetadata with content and frontmatter needed for chunking.
 * Typically obtained by reading the file after getting ResourceMetadata.
 */
export interface ChunkableResource extends ResourceMetadata {
  /** File content (markdown text) */
  content: string;
  /** Parsed frontmatter from the file */
  frontmatter: Record<string, unknown>;
}

/**
 * Chunk a resource using hybrid strategy
 *
 * Strategy:
 * 1. Use heading boundaries as primary splits (from ResourceRegistry)
 * 2. For large sections exceeding target size, split by tokens (paragraphs)
 * 3. Link chunks for context expansion (previousChunkId, nextChunkId)
 *
 * @param resource - Chunkable resource with content and frontmatter
 * @param config - Chunking configuration
 * @returns Chunking result with raw chunks and statistics
 */
export function chunkResource(
  resource: ChunkableResource,
  config: ChunkingConfig
): ChunkingResult {
  const rawChunks: RawChunk[] = [];

  if (resource.headings.length === 0) {
    // No headings - chunk entire content by tokens
    const chunks = chunkByTokens(resource.content, config);
    rawChunks.push(...chunks);
  } else {
    // Extract content between headings
    const lines = resource.content.split('\n');

    for (let i = 0; i < resource.headings.length; i++) {
      const heading = resource.headings[i];
      if (!heading) continue;

      const nextHeading = resource.headings[i + 1];

      // Extract content between this heading and next (or end of file)
      const startLine = heading.line ?? 0;
      const endLine = nextHeading?.line ? nextHeading.line - 1 : lines.length;

      const sectionContent = lines
        .slice(startLine, endLine)
        .join('\n')
        .trim();

      if (sectionContent.length === 0) {
        continue;
      }

      // Build heading path (hierarchy)
      const headingPath = buildHeadingPath(resource.headings, i);

      // Chunk this section by tokens if needed
      const metadata = {
        headingPath,
        headingLevel: heading.level,
        startLine,
        endLine,
      };

      const sectionChunks = chunkByTokens(sectionContent, config, metadata);
      rawChunks.push(...sectionChunks);
    }
  }

  // Calculate statistics
  const tokenCounts = rawChunks.map((c) => config.tokenCounter.count(c.content));
  const stats = {
    totalChunks: rawChunks.length,
    averageTokens: tokenCounts.reduce((sum, t) => sum + t, 0) / rawChunks.length,
    maxTokens: Math.max(...tokenCounts),
    minTokens: Math.min(...tokenCounts),
  };

  return { chunks: rawChunks, stats };
}

/**
 * Build heading path from heading hierarchy
 *
 * @param headings - All headings in resource
 * @param currentIndex - Index of current heading
 * @returns Heading path (e.g., "Architecture > RAG Design > Chunking")
 */
function buildHeadingPath(
  headings: Array<{ level: number; text: string }>,
  currentIndex: number
): string {
  const current = headings[currentIndex];
  if (!current) return '';

  const path: string[] = [current.text];

  // Walk backwards to find parent headings
  for (let i = currentIndex - 1; i >= 0; i--) {
    const heading = headings[i];
    if (!heading) continue;

    if (heading.level < current.level) {
      path.unshift(heading.text);
      if (heading.level === 1) break; // Stop at top level
    }
  }

  return path.join(' > ');
}

/**
 * Enrich raw chunks with full RAGChunk metadata
 *
 * Adds resource metadata, embeddings, chunk IDs, and links between chunks.
 *
 * @param rawChunks - Raw chunks from chunkResource
 * @param resource - Source chunkable resource with frontmatter
 * @param embeddings - Embedding array for each chunk
 * @param embeddingModel - Model used for embeddings
 * @returns Array of complete RAGChunks
 */
export function enrichChunks(
  rawChunks: RawChunk[],
  resource: ChunkableResource,
  embeddings: number[][],
  embeddingModel: string
): RAGChunk[] {
  const enrichedChunks: RAGChunk[] = rawChunks.map((raw, index) => {
    const chunkId = generateChunkId(resource.id, index);
    const contentHash = generateContentHash(raw.content);

    return {
      chunkId,
      resourceId: resource.id,
      content: raw.content,
      contentHash,
      tokenCount: 0, // Will be set by caller
      headingPath: raw.headingPath,
      headingLevel: raw.headingLevel,
      startLine: raw.startLine,
      endLine: raw.endLine,
      filePath: resource.filePath,
      tags: resource.frontmatter['tags'] as string[] | undefined,
      type: resource.frontmatter['type'] as string | undefined,
      title: resource.frontmatter['title'] as string | undefined,
      embedding: embeddings[index] ?? [],
      embeddingModel,
      embeddedAt: new Date(),
      previousChunkId: index > 0 ? generateChunkId(resource.id, index - 1) : undefined,
      nextChunkId:
        index < rawChunks.length - 1 ? generateChunkId(resource.id, index + 1) : undefined,
    };
  });

  return enrichedChunks;
}
