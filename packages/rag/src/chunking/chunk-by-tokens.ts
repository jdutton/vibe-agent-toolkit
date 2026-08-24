/**
 * Token-aware chunking
 *
 * Splits text by token count, respecting paragraph boundaries and descending
 * through progressively finer boundaries until every chunk fits the budget.
 */

import type { TokenCounter } from '../interfaces/token-counter.js';

import type { ChunkingConfig, RawChunk } from './types.js';
import {
  calculateEffectiveTarget,
  splitByLines,
  splitByParagraphs,
  splitBySentences,
  splitByWords,
} from './utils.js';

/** Metadata carried onto every chunk produced from one section. */
interface ChunkMetadata {
  headingPath?: string;
  headingLevel?: number;
  startLine?: number;
  endLine?: number;
}

/** One rung of the splitting ladder: how to break a unit, and how pieces re-join. */
interface SplitRung {
  /** Break a unit into smaller units */
  split: (unit: string) => string[];
  /** Text placed between two pieces when they share a chunk */
  separator: string;
}

/**
 * The splitting ladder below the paragraph level.
 *
 * Each rung breaks a unit the rung above could not fit; the character window
 * (see {@link splitByTokenWindow}) is the terminal rung and always succeeds.
 */
const SPLIT_LADDER: readonly SplitRung[] = [
  { split: splitByLines, separator: '\n' },
  { split: splitBySentences, separator: ' ' },
  { split: splitByWords, separator: ' ' },
];

/**
 * First guess at how many code points one token buys.
 *
 * Only a starting point: the window shrinks until the slice actually measures
 * within budget, so an over-optimistic guess costs a few extra token counts and
 * nothing else.
 */
const CHARS_PER_TOKEN_GUESS = 4;

/**
 * The token budget one chunk may actually occupy.
 *
 * The caller's target is only half the story: a chunk the model cannot read is
 * a chunk whose tail is silently discarded at inference time, so the budget is
 * capped by `modelTokenLimit` regardless of how optimistic `targetChunkSize` is.
 *
 * @param config - Chunking configuration
 * @returns Effective per-chunk token budget, never above the model's limit
 */
function chunkBudget(config: ChunkingConfig): number {
  const target = calculateEffectiveTarget(config.targetChunkSize, config.paddingFactor);
  return Math.min(target, config.modelTokenLimit);
}

/**
 * How many code points from `start` fit the budget.
 *
 * Never returns less than one, so every caller makes progress: a tokenizer that
 * prices a single character above the budget yields one code point per slice
 * rather than an empty slice and an infinite loop.
 *
 * @param codePoints - The atom, already split into code points
 * @param start - Index to measure from
 * @param budget - Per-chunk token budget
 * @param tokenCounter - Token counter to measure with
 * @returns Number of code points to take, at least one
 */
function codePointsWithinBudget(
  codePoints: string[],
  start: number,
  budget: number,
  tokenCounter: TokenCounter
): number {
  const remaining = codePoints.length - start;
  let take = Math.min(remaining, Math.max(1, budget * CHARS_PER_TOKEN_GUESS));

  while (take > 1 && tokenCounter.count(codePoints.slice(start, start + take).join('')) > budget) {
    take = Math.floor(take / 2);
  }

  return take;
}

/**
 * Terminal rung: slice an atom no boundary can break into budget-sized pieces.
 *
 * Slicing is done on code points, never on UTF-16 code units, so a surrogate
 * pair is never torn in half.
 *
 * @param atom - Text with no usable boundary left
 * @param budget - Per-chunk token budget
 * @param tokenCounter - Token counter to measure with
 * @returns Ordered slices whose concatenation is exactly `atom`
 */
function splitByTokenWindow(atom: string, budget: number, tokenCounter: TokenCounter): string[] {
  const codePoints = [...atom];
  const slices: string[] = [];
  let index = 0;

  while (index < codePoints.length) {
    const take = codePointsWithinBudget(codePoints, index, budget, tokenCounter);
    slices.push(codePoints.slice(index, index + take).join(''));
    index += take;
  }

  return slices;
}

/**
 * Greedily pack units into pieces whose joined token count fits the budget.
 *
 * The candidate is measured after joining rather than by summing the units'
 * counts: a separator can cost a token of its own, and summing would let a
 * piece drift one token past the budget.
 *
 * @param units - Units to pack, in order
 * @param separator - Text placed between two units sharing a piece
 * @param config - Chunking configuration
 * @param breakUp - Handles a unit that cannot fit the budget on its own
 * @returns Ordered pieces, each within budget unless `breakUp` says otherwise
 */
function packToBudget(
  units: string[],
  separator: string,
  config: ChunkingConfig,
  breakUp: (unit: string) => string[]
): string[] {
  const { tokenCounter } = config;
  const budget = chunkBudget(config);
  const pieces: string[] = [];
  let current = '';

  for (const unit of units) {
    const candidate = current.length > 0 ? current + separator + unit : unit;
    if (tokenCounter.count(candidate) <= budget) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      pieces.push(current);
      current = '';
    }

    if (tokenCounter.count(unit) <= budget) {
      current = unit;
    } else {
      pieces.push(...breakUp(unit));
    }
  }

  if (current.length > 0) {
    pieces.push(current);
  }

  return pieces;
}

/**
 * Break one over-budget unit into pieces that each fit the budget.
 *
 * Descends the ladder one rung at a time — lines, then sentences, then words —
 * and finishes at the character window, which can always make progress. The
 * function therefore never throws and never discards content: an input with no
 * boundary at all still comes back as budget-sized slices.
 *
 * @param unit - Unit that exceeds the budget
 * @param rungIndex - Index into {@link SPLIT_LADDER} to try next
 * @param config - Chunking configuration
 * @returns Ordered pieces covering the whole unit
 */
function splitToBudget(unit: string, rungIndex: number, config: ChunkingConfig): string[] {
  const budget = chunkBudget(config);
  if (config.tokenCounter.count(unit) <= budget) {
    return [unit];
  }

  const rung = SPLIT_LADDER[rungIndex];
  if (!rung) {
    return splitByTokenWindow(unit, budget, config.tokenCounter);
  }

  const units = rung.split(unit);
  if (units.length <= 1) {
    // This rung found no boundary: try the next one rather than repeating.
    return splitToBudget(unit, rungIndex + 1, config);
  }

  return packToBudget(units, rung.separator, config, (over) =>
    splitToBudget(over, rungIndex + 1, config)
  );
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
  metadata?: ChunkMetadata
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
 * Locate each piece back in the original text and attach line numbers.
 *
 * A piece assembled across boundaries whose whitespace differs from the source
 * will not be found verbatim; the scan then falls back to the running position
 * rather than dropping the piece.
 *
 * @param pieces - Ordered chunk contents
 * @param text - Original text
 * @param baseStartLine - Base line number for this section
 * @param metadata - Metadata to attach to chunks
 * @returns Raw chunks with line numbers
 */
function toChunksWithLineNumbers(
  pieces: string[],
  text: string,
  baseStartLine: number,
  metadata?: ChunkMetadata
): RawChunk[] {
  const chunks: RawChunk[] = [];
  let searchPosition = 0;

  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const found = text.indexOf(trimmed, searchPosition);
    const startPosition = found === -1 ? searchPosition : found;
    chunks.push(createChunkWithLineNumbers(piece, text, startPosition, baseStartLine, metadata));
    searchPosition = startPosition + trimmed.length;
  }

  return chunks;
}

/**
 * Chunk text by token count
 *
 * Splits text when it exceeds the effective budget (targetChunkSize * paddingFactor,
 * capped by the model's own limit — see {@link chunkBudget}), descending the ladder
 * text → paragraphs → lines → sentences → words → character window until every
 * chunk fits. The ladder always terminates, so no input is rejected: an
 * unsplittable atom is sliced by character rather than dropped, and nothing is
 * truncated.
 *
 * @param text - Text to chunk
 * @param config - Chunking configuration
 * @param metadata - Optional metadata to attach to chunks
 * @returns Array of raw chunks
 */
export function chunkByTokens(
  text: string,
  config: ChunkingConfig,
  metadata?: ChunkMetadata
): RawChunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const { tokenCounter } = config;

  // Check if entire text fits
  if (tokenCounter.count(text) <= chunkBudget(config)) {
    return [
      {
        content: text,
        ...metadata,
      },
    ];
  }

  const paragraphs = splitByParagraphs(text);
  const pieces = packToBudget(paragraphs, '\n\n', config, (paragraph) =>
    splitToBudget(paragraph, 0, config)
  );

  return toChunksWithLineNumbers(pieces, text, metadata?.startLine ?? 1, metadata);
}
