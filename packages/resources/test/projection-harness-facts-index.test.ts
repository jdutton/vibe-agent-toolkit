import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { BLOB_PARSE_LIMIT_EXCEEDED, BLOB_PARSE_WORKER_DIED } from '../src/projection/blob-population.js';
import { harnessFactsIndex, HarnessFactsAbsentError, HARNESS_FACTS_ABSENT } from '../src/projection/harness/facts-index.js';
import { HARNESS_PROFILES } from '../src/projection/harness/profile.js';
import type { BlobConditionRow } from '../src/schemas/projection-blobs.js';
import { HarnessIdSchema } from '../src/schemas/projection-harness.js';

const KEY = 'markdown.' + 'a'.repeat(64);
const OTHER = 'markdown.' + 'b'.repeat(64);

describe('harnessFactsIndex', () => {
  const view = {
    harnessBlobFacts: [{ blob: KEY, harness: 'claude-code' as const, injectedBytes: 0, injectedTokens: 0, paths: null }],
    harnessBlobImports: [],
    blobConditions: [] as BlobConditionRow[],
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

  it('reads a blob whose read this run refused as refused, and only for a parse-refusal code', () => {
    const refusal = (code: string): BlobConditionRow => ({ blob: OTHER, code, severity: 'warning', message: 'm', line: null });
    expect(harnessFactsIndex(view, 'claude-code').refused(OTHER)).toBe(false);
    expect(harnessFactsIndex({ ...view, blobConditions: [refusal(BLOB_PARSE_LIMIT_EXCEEDED)] }, 'claude-code').refused(OTHER)).toBe(true);
    expect(harnessFactsIndex({ ...view, blobConditions: [refusal(BLOB_PARSE_WORKER_DIED)] }, 'claude-code').refused(OTHER)).toBe(true);
    expect(harnessFactsIndex({ ...view, blobConditions: [refusal('PARSE_ODDITY')] }, 'claude-code').refused(OTHER)).toBe(false);
  });

  it('rebuilds a memoized index when a refusal row arrives in the same view', () => {
    const conditions: BlobConditionRow[] = [];
    const live = { ...view, blobConditions: conditions };
    expect(harnessFactsIndex(live, 'claude-code').refused(OTHER)).toBe(false);
    conditions.push({ blob: OTHER, code: BLOB_PARSE_LIMIT_EXCEEDED, severity: 'warning', message: 'm', line: null });
    expect(harnessFactsIndex(live, 'claude-code').refused(OTHER)).toBe(true);
  });

  it('keeps one harness vocabulary between the schema and the registry', () => {
    expect([...HarnessIdSchema.options].sort(compareCodeUnits)).toEqual(Object.keys(HARNESS_PROFILES).sort(compareCodeUnits));
  });
});
