/**
 * Resource chunking
 *
 * Chunks ResourceMetadata using hybrid heading-based + token-aware strategy.
 */

import type { HeadingNode, ResourceMetadata } from '@vibe-agent-toolkit/resources';

import type { TokenCounter } from '../interfaces/token-counter.js';
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
 * Index just past a leading YAML frontmatter block.
 *
 * Heading line numbers are absolute in the file, so the region above the first
 * heading includes the frontmatter fence. Embedding that YAML would give every
 * frontmatter-carrying document in a corpus an extra chunk of metadata prose,
 * which is noise at index time and cost at embed time.
 *
 * An unterminated opening fence is not frontmatter: the document simply starts
 * with a thematic break, and its first line is content.
 *
 * @param lines - Document content split on newlines
 * @returns 0-based index of the first line that is not frontmatter
 */
function contentStartIndex(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i]?.trim();
    if (trimmed === '---' || trimmed === '...') return i + 1;
  }

  return 0;
}

/**
 * Chunk the unheaded prose between two line indices, frontmatter excluded.
 *
 * Serves BOTH unheaded regions a document can have, and serves them the same
 * way on purpose:
 *
 * - the **preamble**, above the first heading. A document opening with an
 *   abstract, a TL;DR or a lead paragraph used to index that prose at zero
 *   chunks — the section walk began AT the first heading, and everything above
 *   it was dropped with no error, no warning and no counter.
 * - the **whole document**, when it carries no headings at all. That path used
 *   to hand the entire file to the chunker, YAML fence included, so the same
 *   body indexed differently depending on whether anybody had written a `#`
 *   into it: with a heading the frontmatter was dropped, without one it became
 *   retrievable prose. Nobody chose that; it fell out of two code paths where
 *   only one had been taught about frontmatter.
 *
 * The resulting chunks carry NO `headingPath` and NO `headingLevel`. Unheaded
 * prose belongs to no section, and labelling it with the heading it sits above
 * would make it retrievable under a heading that does not describe it — a worse
 * failure than the omission this replaces. `headingPath` is already optional on
 * {@link RawChunk}, so downstream consumers see the shape they already handle.
 *
 * A region with nothing but frontmatter and blanks in it yields NO chunks. For
 * a frontmatter-only document that means zero chunks overall, which is the
 * honest answer — there is no prose to retrieve, and an index entry whose
 * content is a YAML fence answers no query anyone will ask. It is not an error,
 * and {@link chunkResource}'s statistics report it as zero rather than as the
 * `NaN` an empty average used to produce.
 *
 * @param lines - Document content split on newlines
 * @param limit - 0-based exclusive end of the region (the first heading's own
 *   line index, or the line count for a document with no headings)
 * @param config - Chunking configuration
 * @returns Chunks covering the region's prose, or none when it has none
 */
function chunkUnheadedRegion(
  lines: string[],
  limit: number,
  config: ChunkingConfig
): RawChunk[] {
  let start = contentStartIndex(lines);
  while (start < limit && lines[start]?.trim() === '') start++;

  let end = limit;
  while (end > start && lines[end - 1]?.trim() === '') end--;

  if (end <= start) return [];

  // `start`/`end` are already trimmed to real content, so the 1-based line
  // numbers below are the prose's own — not the frontmatter's or a blank's.
  return chunkByTokens(lines.slice(start, end).join('\n'), config, {
    startLine: start + 1,
    endLine: end,
  });
}

/**
 * Token statistics over a set of chunks.
 *
 * Zero chunks is a real outcome, not an error: a document that is only
 * frontmatter has no prose to retrieve, and {@link chunkUnheadedRegion} says so
 * by returning nothing. Computed naively that outcome reported `NaN` for the
 * average (a division by zero length) and `-Infinity`/`+Infinity` for the
 * extremes (`Math.max` and `Math.min` over an empty list return their identity
 * elements). None of the three is a JSON value, so any caller serializing this
 * object published `null` where a reader expects a count — a corruption that
 * appears only after the value leaves the process.
 *
 * Zero is the honest reading of all four: no chunks were produced, so no tokens
 * were spent, and the largest and smallest of nothing are nothing.
 *
 * @param chunks - The chunks produced for one resource
 * @param tokenCounter - Token counter to measure each chunk with
 * @returns Statistics that are always finite numbers
 */
function summarize(chunks: RawChunk[], tokenCounter: TokenCounter): ChunkingResult['stats'] {
  if (chunks.length === 0) {
    return { totalChunks: 0, averageTokens: 0, maxTokens: 0, minTokens: 0 };
  }

  const tokenCounts = chunks.map((c) => tokenCounter.count(c.content));

  return {
    totalChunks: chunks.length,
    averageTokens: tokenCounts.reduce((sum, t) => sum + t, 0) / chunks.length,
    maxTokens: Math.max(...tokenCounts),
    minTokens: Math.min(...tokenCounts),
  };
}

/**
 * Chunk a resource using hybrid strategy
 *
 * Strategy:
 * 1. Chunk any content above the first heading (see {@link chunkUnheadedRegion})
 * 2. Use heading boundaries as primary splits (from ResourceRegistry)
 * 3. For large sections exceeding target size, split by tokens (paragraphs)
 * 4. Link chunks for context expansion (previousChunkId, nextChunkId)
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

  // Flatten nested heading tree into a sorted list
  const flatHeadings = flattenHeadings(resource.headings);

  const lines = resource.content.split('\n');

  if (flatHeadings.length === 0) {
    // No headings: the whole document is one unheaded region.
    rawChunks.push(...chunkUnheadedRegion(lines, lines.length, config));
  } else {
    // Everything above the first heading, then the sections themselves. The
    // heading's own line belongs to its section, so the region ends one line
    // short of it — and `line` is 1-based, which makes that index `line - 1`.
    rawChunks.push(...chunkUnheadedRegion(lines, (flatHeadings[0]?.line ?? 1) - 1, config));

    for (let i = 0; i < flatHeadings.length; i++) {
      const heading = flatHeadings[i];
      if (!heading) continue;

      const nextHeading = flatHeadings[i + 1];

      // Extract content between this heading and next (or end of file)
      // Note: heading.line is 1-based, but array indices are 0-based
      const headingLine = heading.line ?? 1; // 1-based line number
      const nextHeadingLine = nextHeading?.line ?? (lines.length + 1); // 1-based line number

      // Convert to 0-based array indices for slicing
      const startIndex = headingLine - 1;
      const endIndex = nextHeadingLine - 1;

      const sectionContent = lines
        .slice(startIndex, endIndex)
        .join('\n')
        .trim();

      if (sectionContent.length === 0) {
        continue;
      }

      // Build heading path (hierarchy)
      const headingPath = buildHeadingPath(flatHeadings, i);

      // Chunk this section by tokens if needed
      // Pass 1-based line numbers as metadata
      const metadata = {
        headingPath,
        headingLevel: heading.level,
        startLine: headingLine,
        endLine: nextHeadingLine - 1, // Last line of this section
      };

      const sectionChunks = chunkByTokens(sectionContent, config, metadata);
      rawChunks.push(...sectionChunks);
    }
  }

  return { chunks: rawChunks, stats: summarize(rawChunks, config.tokenCounter) };
}

/**
 * Flatten nested heading tree into a flat array
 *
 * Converts hierarchical heading structure (with children) into a flat list
 * sorted by line number, suitable for section extraction.
 *
 * @param headings - Hierarchical heading nodes
 * @returns Flat array of headings sorted by line number
 */
function flattenHeadings(headings: HeadingNode[]): HeadingNode[] {
  const result: HeadingNode[] = [];

  function traverse(nodes: HeadingNode[]) {
    for (const node of nodes) {
      result.push(node);
      if (node.children && node.children.length > 0) {
        traverse(node.children);
      }
    }
  }

  traverse(headings);

  // Sort by line number to ensure sections are in document order
  return result.sort((a, b) => {
    const lineA = a.line ?? 0;
    const lineB = b.line ?? 0;
    return lineA - lineB;
  });
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
 * @param tokenCounter - Optional token counter to compute token counts (defaults to 0 if not provided)
 * @returns Array of complete RAGChunks
 */
export function enrichChunks(
  rawChunks: RawChunk[],
  resource: ChunkableResource,
  embeddings: number[][],
  embeddingModel: string,
  tokenCounter?: TokenCounter,
): RAGChunk[] {
  const enrichedChunks: RAGChunk[] = rawChunks.map((raw, index) => {
    const chunkId = generateChunkId(resource.id, index);
    const contentHash = generateContentHash(raw.content);

    return {
      chunkId,
      resourceId: resource.id,
      content: raw.content,
      contentHash,
      tokenCount: tokenCounter ? tokenCounter.count(raw.content) : 0,
      chunkIndex: index,
      totalChunks: rawChunks.length,
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
