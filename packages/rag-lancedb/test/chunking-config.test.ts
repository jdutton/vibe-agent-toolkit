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
 * it. `indexResource` needs a live LanceDB connection — and the provider module
 * imports `@lancedb/lancedb` and the ONNX embedder at load time — so the call is
 * out of reach of a unit test. This reads the route instead of the behaviour,
 * deliberately, so a correct resolver cannot sit next to an unchanged caller and
 * still look green.
 *
 * ⛔ It used to read the route with `expect(source).toContain('resolveChunkingConfig')`,
 * and that assertion COULD NOT FAIL. The identifier also appears in a `{@link}`
 * inside the `targetChunkSize` JSDoc, so deleting the import, deleting
 * `getChunkingConfig` outright and reverting the caller to a hand-rolled config
 * literal left the suite 12/12 green — measured, by doing exactly that.
 *
 * Every pattern below is therefore anchored to a shape a comment cannot take:
 * `^import` at the start of a line, and a `key:` whose line begins with the key
 * rather than with a `*`. That is stricter than stripping comment lines first,
 * because it also refuses a mention embedded in a fenced `@example`.
 */

/** A real import statement, not a mention. A JSDoc line starts with `*`. */
const RESOLVER_IMPORT =
  /^import\s*\{[^}]*\bresolveChunkingConfig\b[^}]*\}\s*from\s*'\.\/chunking-config\.js';/mu;

/** Characters from `chunkResource(` that the call and its arguments occupy. */
const CALL_WINDOW = 400;

/**
 * Is the chunker handed the RESOLVED config, rather than one assembled inline?
 *
 * Scoped to a window at the call rather than the whole file, so an unrelated
 * `getChunkingConfig()` call elsewhere could not stand in for this one. The
 * provider contains exactly one `chunkResource(` — the import spells the name
 * without parentheses, and no comment writes the call form.
 *
 * @param source - The provider's own source text
 * @returns True when the resolved config reaches the chunker
 */
function passesResolvedConfigToChunker(source: string): boolean {
  const at = source.indexOf('chunkResource(');
  return at !== -1 && source.slice(at, at + CALL_WINDOW).includes('this.getChunkingConfig()');
}

/**
 * Does the provider assemble a chunking config of its own?
 *
 * `modelTokenLimit` is required by `ChunkingConfig`, so EVERY revert to a
 * hand-rolled config has to write this key — whether it hardcodes ada-002's
 * 8191 (which is what shipped, applied to a local model that reads 256) or
 * derives the number inline and skips the clamping and the warnings the
 * resolver owes its caller.
 *
 * Comment lines are excluded, and the key is looked for ANYWHERE on a code line
 * rather than at its start: a revert written as a one-line `{ targetChunkSize:
 * …, modelTokenLimit: … }` puts the key mid-line, and a start-anchored pattern
 * let exactly that shape through when it was tried against the real file.
 *
 * @param source - The provider's own source text
 * @returns True when the provider writes its own config literal
 */
function declaresOwnChunkingConfig(source: string): boolean {
  return source.split('\n').some((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false;
    return trimmed.includes('modelTokenLimit');
  });
}

describe('LanceDBRAGProvider chunking wiring', () => {
  it('imports the resolver', async () => {
    expect(RESOLVER_IMPORT.test(await readProviderSource())).toBe(true);
  });

  it('hands the resolved config to the chunker at the call site', async () => {
    expect(passesResolvedConfigToChunker(await readProviderSource())).toBe(true);
  });

  it('writes no chunking-config literal of its own', async () => {
    expect(declaresOwnChunkingConfig(await readProviderSource())).toBe(false);
  });

  /**
   * The guard proves it can fail, in the suite, rather than in a commit message.
   *
   * Each control puts the source into the broken state the assertion above
   * claims to catch and asserts the assertion goes false — and the first one
   * also pins WHY the old test was worthless: with the import deleted, a bare
   * `toContain` is still satisfied by the surviving JSDoc `{@link}`.
   */
  describe('negative controls', () => {
    it('sees the import deleted, where a bare identifier match does not', async () => {
      const withoutImport = (await readProviderSource()).replace(RESOLVER_IMPORT, '');

      expect(withoutImport).toContain('resolveChunkingConfig');
      expect(RESOLVER_IMPORT.test(withoutImport)).toBe(false);
    });

    it('sees the caller reverted to a hand-rolled config literal', async () => {
      // The one-line shape on purpose: this is the revert that slipped past the
      // first attempt at `declaresOwnChunkingConfig`, which anchored the key to
      // the start of a line.
      const reverted = (await readProviderSource()).replace(
        'this.getChunkingConfig()',
        '{ targetChunkSize: 460, modelTokenLimit: 8191, paddingFactor: 0.9, tokenCounter: this.tokenCounter }',
      );

      expect(passesResolvedConfigToChunker(reverted)).toBe(false);
      expect(declaresOwnChunkingConfig(reverted)).toBe(true);
    });
  });
});
