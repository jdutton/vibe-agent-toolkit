/**
 * Unit tests for chunking-config resolution.
 *
 * The defect this pins: `vat rag index` packed chunks to 512 * 0.9 = 460
 * estimated tokens and handed them to a local model that reads 256 — and the
 * "exceeds model token limit" guard was hardcoded to 8191 (OpenAI ada-002's
 * limit, 32x the local model's), so it could never fire. Chunks were cut at
 * inference time with nothing said.
 *
 * ⛔ This used to quote "84-86% of chunks truncated; 42-44% of every corpus".
 * Retired, not corrected — measured against raw `chunkByTokens`, not the shipped
 * `chunkResource` path. See the retirement in `src/chunking-config.ts`.
 *
 * The chunk budget must therefore be DERIVED from the embedding provider's own
 * published limit, never from a constant.
 */

import { readFile } from 'node:fs/promises';

import type { EmbeddingProvider, TokenCounter } from '@vibe-agent-toolkit/rag';
import { describe, expect, it } from 'vitest';

import {
  ESTIMATOR_DIVERGENCE_FACTOR,
  SPECIAL_TOKEN_OVERHEAD,
  resolveChunkingConfig,
} from '../src/chunking-config.js';

/** Token counter stub — resolution is arithmetic on limits, it never counts. */
const tokenCounter: TokenCounter = {
  name: 'stub',
  count: () => 0,
  countBatch: (texts: string[]) => texts.map(() => 0),
};

function providerWithLimit(maxInputTokens: number): EmbeddingProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    dimensions: 1,
    maxInputTokens,
    embed: () => Promise.resolve([]),
    embedBatch: () => Promise.resolve([]),
  };
}

const LOCAL_LIMIT = 256;
const CLOUD_LIMIT = 8192;

/**
 * @returns The LanceDB provider's own source text
 */
async function readProviderSource(): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path relative to this test file
  return readFile(new URL('../src/lancedb-rag-provider.ts', import.meta.url), 'utf8');
}

describe('resolveChunkingConfig', () => {
  it('takes the model token limit from the provider, not a constant', () => {
    const { config } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: undefined,
    });

    expect(config.modelTokenLimit).toBe(LOCAL_LIMIT);
  });

  it('tracks a different provider limit rather than reporting a fixed one', () => {
    const { config } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(CLOUD_LIMIT),
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: undefined,
    });

    expect(config.modelTokenLimit).toBe(CLOUD_LIMIT);
  });

  it('defaults the chunk target to the provider limit instead of 512', () => {
    const { config } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: undefined,
    });

    expect(config.targetChunkSize).toBe(LOCAL_LIMIT);
  });

  // ⛔ This test used to present itself as "the assertion the whole defect
  // reduces to". It is an ALGEBRAIC IDENTITY and proves nothing about the
  // divergence factor.
  //
  //   derivePaddingFactor(L) = floor(((L-2)/(L·F))·100)/100 ≤ (L-2)/(L·F)
  //   ⇒ floor(L·p)·F + 2 ≤ ((L-2)/F)·F + 2 = L,  for ANY F > 0
  //
  // Both sides read the same `ESTIMATOR_DIVERGENCE_FACTOR`, so it cancels.
  // Verified numerically over 15,559,685 combinations (L = 8..8192 × F =
  // 1.00..20.00 step 0.01): ZERO breaks. At F = 20 the resolver quietly returns
  // `paddingFactor: 0.04` — a 10-token chunk out of a 256-token window — and
  // the old assertion still passed green.
  //
  // 🔑 It is kept, because the identity IS the invariant the resolver owes its
  // caller and a refactor that broke it would be a real defect. What is added
  // beside it is the discriminator the identity cannot be: a bound on how much
  // of the model's window a full chunk is allowed to give away. That is what
  // separates a plausible divergence factor from an absurd one.
  it('leaves the default worst-case chunk inside what the model will read', () => {
    const provider = providerWithLimit(LOCAL_LIMIT);
    const { config, warnings } = resolveChunkingConfig({
      embeddingProvider: provider,
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: undefined,
    });

    const effectiveTarget = Math.floor(config.targetChunkSize * config.paddingFactor);
    const worstCaseModelTokens =
      effectiveTarget * ESTIMATOR_DIVERGENCE_FACTOR + SPECIAL_TOKEN_OVERHEAD;

    expect(worstCaseModelTokens).toBeLessThanOrEqual(LOCAL_LIMIT);
    expect(warnings).toEqual([]);
  });

  it('does not give away most of the model window to the safety margin', () => {
    // The discriminating half. `MIN_WINDOW_UTILISATION` is a floor on how much
    // of the model's own limit one full chunk may actually carry, and it is
    // deliberately NOT derived from ESTIMATOR_DIVERGENCE_FACTOR — a bound
    // computed from the constant under test would cancel exactly the way the
    // identity above does.
    //
    // 0.5 is a wide bound, chosen so this test fails only on an absurd factor
    // rather than on a re-calibration. Today's 1.18 yields 0.84 utilisation; a
    // move to the p99 tail bound (~1.55) would still yield ~0.63 and pass. F=20
    // yields 0.04 and fails, which is the whole point.
    const MIN_WINDOW_UTILISATION = 0.5;

    const { config } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: undefined,
    });

    const effectiveTarget = Math.floor(config.targetChunkSize * config.paddingFactor);

    expect(effectiveTarget / LOCAL_LIMIT).toBeGreaterThanOrEqual(MIN_WINDOW_UTILISATION);
  });

  it('clamps an explicit target that overshoots the provider, and says so', () => {
    const { config, warnings } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: 512,
      paddingFactor: undefined,
    });

    expect(config.targetChunkSize).toBe(LOCAL_LIMIT);
    expect(warnings.join('\n')).toMatch(/512/);
    expect(warnings.join('\n')).toMatch(/256/);
  });

  it('honours an explicit target that fits', () => {
    const { config, warnings } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: 128,
      paddingFactor: undefined,
    });

    expect(config.targetChunkSize).toBe(128);
    expect(warnings).toEqual([]);
  });

  it('warns when an explicit padding factor reopens the truncation gap', () => {
    // 0.9 was the shipped default: 256 * 0.9 = 230 cl100k tokens, ~271 WordPiece.
    // Still over 256. If a caller asks for it, they get it — but not silently.
    const { config, warnings } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: 0.9,
    });

    expect(config.paddingFactor).toBeCloseTo(0.9, 10);
    expect(warnings.join('\n')).toMatch(/truncat/i);
  });

  it('refuses a provider whose published limit leaves no room for content', () => {
    // A provider reporting 0 would otherwise resolve to an empty budget and
    // chunk forever — the silent-zero shape this whole fix exists to remove.
    expect(() =>
      resolveChunkingConfig({
        embeddingProvider: providerWithLimit(0),
        tokenCounter,
        targetChunkSize: undefined,
        paddingFactor: undefined,
      }),
    ).toThrow(/maxInputTokens=0/);
  });

  it('passes the caller token counter straight through', () => {
    const { config } = resolveChunkingConfig({
      embeddingProvider: providerWithLimit(LOCAL_LIMIT),
      tokenCounter,
      targetChunkSize: undefined,
      paddingFactor: undefined,
    });

    expect(config.tokenCounter).toBe(tokenCounter);
  });
});

/**
 * The resolver above is only worth anything if the indexing path actually calls
 * it. `indexResource` needs a live LanceDB connection, so it is out of reach of
 * a unit test — this reads the route instead of the behaviour, deliberately, so
 * a correct resolver cannot sit next to an unchanged caller and still look green.
 */
describe('LanceDBRAGProvider chunking wiring', () => {
  it('routes chunking config through the resolver', async () => {
    const source = await readProviderSource();

    expect(source).toContain('resolveChunkingConfig');
  });

  it('carries no hardcoded model token limit', async () => {
    const source = await readProviderSource();

    // 8191 is ada-002's limit. It was applied to every provider, including a
    // local model that reads 256, which made the guard permanently dead.
    expect(source).not.toContain('8191');
  });
});
