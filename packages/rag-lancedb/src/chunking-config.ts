/**
 * Chunking-budget resolution.
 *
 * Decides how much text may go into one chunk, given the embedding provider
 * that will have to read it. The whole point is that the answer is DERIVED from
 * the provider rather than assumed: the previous hardcoded pair (512-token
 * target, 8191-token "model limit") described OpenAI ada-002 and was applied to
 * every provider, including the default local all-MiniLM-L6-v2, which reads 256.
 * The consequence that needs no measurement to state: **8191 is 32x the real
 * limit**, so the "exceeds model token limit" guard could not fire at all, and
 * every chunk over 256 tokens was cut at inference time with nothing said.
 *
 * ⛔ This paragraph used to carry *"84-86% of chunks truncated, 42-44% of every
 * corpus never reaching the model"*, stated flatly and in the present tense.
 * Retired rather than corrected. It was measured against raw `chunkByTokens`,
 * and the SHIPPED path is `chunkResource`, which splits at markdown headings
 * FIRST — so the figure does not reproduce against the thing it describes, and
 * an independent re-measurement through the real path put the token loss
 * roughly a third to a half of that. Neither number is written here: a
 * corpus-shaped percentage moves whenever the corpus does, and this file's
 * argument does not need one. Measure the claim's OWN subject, or make no
 * claim.
 */

import { calculateEffectiveTarget } from '@vibe-agent-toolkit/rag';
import type { ChunkingConfig, EmbeddingProvider, TokenCounter } from '@vibe-agent-toolkit/rag';

/**
 * How much higher the embedder's own tokenizer counts than the chunker's.
 *
 * The local model tokenizes in BERT WordPiece over a ~30k vocab, which splits
 * the same text into more pieces than the estimators upstream of it. A budget
 * that ignores the gap overflows even when the target equals the model's limit
 * exactly, so the safety margin is sized against the top of a measured range.
 *
 * ⚠️ **A ratio whose operands are unstated is not a measurement.** The range this
 * 1.18 comes from is **`chars/4` → WordPiece**, measured 2026-08 across four
 * corpora: **1.13-1.18x at p50, 1.30-1.41x at p90**. `chars/4` is
 * {@link FastTokenCounter}; the counter the shipped LanceDB path passes in is
 * {@link ApproximateTokenCounter}, which counts in **cl100k** (gpt-tokenizer).
 * So this factor is the top of a p50 range measured against a DIFFERENT
 * estimator than the one it is applied to — **cl100k → WordPiece has never been
 * measured** — and `tokenCounter` is a caller input, so a caller may supply
 * either. Restating either ratio without naming both of its ends puts the
 * mis-attribution back.
 *
 * ⚠️ **p50 sizes the margin; p90 is why the margin is not a guarantee.** At
 * 1.30-1.41x roughly a tenth of chunks diverge half again as far as this factor
 * allows for, so the padding derived from it bounds the typical chunk and not
 * the tail. Raising the constant to cover p90 is a budget decision with a recall
 * cost, not a bug fix — and it wants the cl100k measurement first, because the
 * tail belongs to the same estimator pair the p50 does.
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
        // Deliberately does not name the chunker's estimator: `tokenCounter` is a caller
        // input, so it may be cl100k or `chars/4`, and the factor was measured against the
        // latter. Naming one of them here shipped a mis-attribution to adopters.
        `truncate: the model's own tokenizer counts ~${String(ESTIMATOR_DIVERGENCE_FACTOR)}x higher than the chunker's estimate, ` +
        `which overruns its ${String(modelTokenLimit)}-token limit. Lower paddingFactor or targetChunkSize.`,
    );
  }

  return { config, warnings };
}
