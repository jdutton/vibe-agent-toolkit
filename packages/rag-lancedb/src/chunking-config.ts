/**
 * Chunking-budget resolution.
 *
 * Decides how much text may go into one chunk, given the embedding provider
 * that will have to read it. The whole point is that the answer is DERIVED from
 * the provider rather than assumed: the previous hardcoded pair (512-token
 * target, 8191-token "model limit") described OpenAI ada-002 and was applied to
 * every provider, including the default local all-MiniLM-L6-v2, which reads 256.
 * Measured consequence: 84-86% of chunks truncated, 42-44% of every corpus never
 * reaching the model, and an "exceeds model token limit" guard that could not
 * fire because 8191 is 32x the real limit.
 */

import { calculateEffectiveTarget } from '@vibe-agent-toolkit/rag';
import type { ChunkingConfig, EmbeddingProvider, TokenCounter } from '@vibe-agent-toolkit/rag';

/**
 * How much higher the embedder's own tokenizer counts than the chunker's.
 *
 * The chunker measures in cl100k (gpt-tokenizer); the local model tokenizes in
 * BERT WordPiece over a ~30k vocab, which splits the same text into more
 * pieces — measured at 1.13-1.18x at p50 across four corpora. A budget that
 * ignores the gap overflows even when the target equals the model's limit
 * exactly, so the safety margin is sized against the top of that range.
 */
export const ESTIMATOR_DIVERGENCE_FACTOR = 1.18;

/** [CLS] and [SEP] — charged to the sequence budget before any content. */
export const SPECIAL_TOKEN_OVERHEAD = 2;

/** Inputs to {@link resolveChunkingConfig}. */
export interface ChunkingConfigInputs {
  /** The provider that will embed the chunks; its limit sets the budget. */
  embeddingProvider: EmbeddingProvider;
  /** Counter the chunker will measure with. */
  tokenCounter: TokenCounter;
  /** Caller override, or `undefined` to derive from the provider. */
  targetChunkSize: number | undefined;
  /** Caller override, or `undefined` to derive from the provider. */
  paddingFactor: number | undefined;
}

/** A resolved budget plus anything the caller ought to hear about it. */
export interface ResolvedChunkingConfig {
  config: ChunkingConfig;
  /** Empty when the resolved budget is safe. Never swallowed — surface these. */
  warnings: string[];
}

/**
 * Largest padding factor that keeps a full chunk inside the model's limit.
 *
 * Derived, not chosen: the effective target (`target * padding`) is measured in
 * the chunker's units, so it must survive multiplication by the tokenizer
 * divergence and still leave room for the two special tokens. Rounded DOWN to
 * two decimals — a readable number that cannot round its way over the limit.
 *
 * @param modelTokenLimit - The provider's real per-input token limit
 * @returns Padding factor in (0, 1]
 */
function derivePaddingFactor(modelTokenLimit: number): number {
  const contentBudget = modelTokenLimit - SPECIAL_TOKEN_OVERHEAD;
  const raw = contentBudget / (modelTokenLimit * ESTIMATOR_DIVERGENCE_FACTOR);
  return Math.floor(raw * 100) / 100;
}

/**
 * Worst-case tokens the model will be asked to read for one full chunk.
 *
 * @param config - A resolved chunking config
 * @returns Estimated model-side token count including special tokens
 */
function worstCaseModelTokens(config: ChunkingConfig): number {
  const effectiveTarget = calculateEffectiveTarget(config.targetChunkSize, config.paddingFactor);
  return effectiveTarget * ESTIMATOR_DIVERGENCE_FACTOR + SPECIAL_TOKEN_OVERHEAD;
}

/**
 * Resolve the chunking budget for a given embedding provider.
 *
 * Caller overrides are honoured, not silently replaced — but an override that
 * puts chunks back over the model's limit comes back as a warning rather than
 * as invisible data loss at embed time.
 *
 * @param inputs - Provider, counter, and any caller overrides
 * @returns The resolved config and any warnings about it
 * @throws If the provider reports a limit that cannot hold content
 */
export function resolveChunkingConfig(inputs: ChunkingConfigInputs): ResolvedChunkingConfig {
  const { embeddingProvider, tokenCounter } = inputs;
  const modelTokenLimit = embeddingProvider.maxInputTokens;

  if (!Number.isInteger(modelTokenLimit) || modelTokenLimit <= SPECIAL_TOKEN_OVERHEAD) {
    throw new Error(
      `Embedding provider '${embeddingProvider.name}' reports maxInputTokens=${String(modelTokenLimit)}, ` +
        'which leaves no room for content. A provider must publish its real per-input token limit.',
    );
  }

  const warnings: string[] = [];

  let targetChunkSize = inputs.targetChunkSize ?? modelTokenLimit;
  if (targetChunkSize > modelTokenLimit) {
    warnings.push(
      `targetChunkSize ${String(targetChunkSize)} exceeds the ${String(modelTokenLimit)}-token limit of ` +
        `'${embeddingProvider.model}' and has been clamped to ${String(modelTokenLimit)}. ` +
        'Text past the limit is discarded before inference.',
    );
    targetChunkSize = modelTokenLimit;
  }

  const config: ChunkingConfig = {
    targetChunkSize,
    modelTokenLimit,
    paddingFactor: inputs.paddingFactor ?? derivePaddingFactor(modelTokenLimit),
    tokenCounter,
  };

  if (worstCaseModelTokens(config) > modelTokenLimit) {
    warnings.push(
      `Chunk budget (targetChunkSize ${String(config.targetChunkSize)} x paddingFactor ` +
        `${String(config.paddingFactor)}) can produce chunks that '${embeddingProvider.model}' will ` +
        `truncate: the chunker counts in cl100k but the model tokenizes ~${String(ESTIMATOR_DIVERGENCE_FACTOR)}x higher, ` +
        `which overruns its ${String(modelTokenLimit)}-token limit. Lower paddingFactor or targetChunkSize.`,
    );
  }

  return { config, warnings };
}
