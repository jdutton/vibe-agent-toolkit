/**
 * Unit tests for chunking-config resolution.
 *
 * The defect this pins: `vat rag index` packed chunks to 512 * 0.9 = 460
 * estimated tokens and handed them to a local model that reads 256 — and the
 * "exceeds model token limit" guard was hardcoded to 8191 (OpenAI ada-002's
 * limit, 32x the local model's), so it could never fire. 84-86% of chunks were
 * truncated; 42-44% of every corpus never reached the model.
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

  it('leaves the default worst-case chunk inside what the model will read', () => {
    // This is the assertion the whole defect reduces to. The chunker counts in
    // cl100k; the local model tokenizes in WordPiece, which runs 1.13-1.18x
    // higher at p50. A budget that ignores that divergence overflows even when
    // targetChunkSize equals the model limit exactly.
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

    expect(config.paddingFactor).toBe(0.9);
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
