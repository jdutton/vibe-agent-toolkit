import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { harnessFactsIndex, HarnessFactsAbsentError, HARNESS_FACTS_ABSENT } from '../src/projection/harness/facts-index.js';
import { HARNESS_PROFILES } from '../src/projection/harness/profile.js';
import { HarnessIdSchema } from '../src/schemas/projection-harness.js';

const KEY = 'markdown.' + 'a'.repeat(64);
const OTHER = 'markdown.' + 'b'.repeat(64);

describe('harnessFactsIndex', () => {
  const view = {
    harnessBlobFacts: [{ blob: KEY, harness: 'claude-code' as const, injectedBytes: 0, injectedTokens: 0, paths: null }],
    harnessBlobImports: [],
  };

  it('tells a derived zero apart from an absent row', () => {
    const index = harnessFactsIndex(view, 'claude-code');
    expect(index.factsOf(KEY)?.injectedTokens).toBe(0);
    expect(index.factsOf(OTHER)).toBeUndefined();
  });

  it('throws a coded error, naming the blob and path, when a reached blob has no facts', () => {
    expect.assertions(5);
    const index = harnessFactsIndex(view, 'claude-code');
    expect(() => index.requireFacts(OTHER, 'acme/CLAUDE.md')).toThrow(HarnessFactsAbsentError);
    try { index.requireImports(OTHER, 'acme/CLAUDE.md'); } catch (error) {
      expect((error as HarnessFactsAbsentError).code).toBe(HARNESS_FACTS_ABSENT);
      expect((error as Error).message).toContain('acme/CLAUDE.md');
      expect((error as Error).message).toContain(OTHER);
    }
    expect(index.requireImports(KEY, null)).toEqual([]);
  });

  it('returns a derived blob\'s imports in ordinal order, and only its own harness\'s', () => {
    const imports = [
      { blob: KEY, harness: 'claude-code' as const, ordinal: 1, rawRef: '@b.md', target: 'b.md', line: 2 },
      { blob: KEY, harness: 'claude-code' as const, ordinal: 0, rawRef: '@a.md', target: 'a.md', line: 1 },
    ];
    const index = harnessFactsIndex({ ...view, harnessBlobImports: imports }, 'claude-code');
    expect(index.requireImports(KEY, null).map((row) => row.target)).toEqual(['a.md', 'b.md']);
  });

  it('keeps one harness vocabulary between the schema and the registry', () => {
    expect([...HarnessIdSchema.options].sort(compareCodeUnits)).toEqual(Object.keys(HARNESS_PROFILES).sort(compareCodeUnits));
  });
});
