import { describe, expect, it } from 'vitest';

import { computeReconcilePlan, StagedManifestSchema } from '../../src/skill-test/manifest.js';

const entry = (name: string, identity: string, contentHash: string) => ({ name, identity, contentHash });

describe('StagedManifestSchema', () => {
  it('rejects unknown keys (strict)', () => {
    expect(() => StagedManifestSchema.parse({ fingerprint: 'f', entries: [], bogus: 1 })).toThrow();
  });
});

describe('computeReconcilePlan', () => {
  it('stages everything when no current manifest', () => {
    const plan = computeReconcilePlan([entry('a', 'id-a', 'h-a')], null);
    expect(plan.toStage.map(e => e.name)).toEqual(['a']);
    expect(plan.toPrune).toEqual([]);
  });

  it('marks unchanged only when identity AND contentHash both match', () => {
    const current = { fingerprint: 'f', entries: [entry('a', 'id-a', 'h-a')] };
    const plan = computeReconcilePlan([entry('a', 'id-a', 'h-a')], current);
    expect(plan.unchanged.map(e => e.name)).toEqual(['a']);
    expect(plan.toStage).toEqual([]);
  });

  it('re-stages when contentHash drifted even though identity matches (manifest not trusted)', () => {
    const current = { fingerprint: 'f', entries: [entry('a', 'id-a', 'STALE')] };
    const plan = computeReconcilePlan([entry('a', 'id-a', 'h-a')], current);
    expect(plan.toStage.map(e => e.name)).toEqual(['a']);
  });

  it('prunes no-longer-declared entries', () => {
    const current = { fingerprint: 'f', entries: [entry('a', 'id-a', 'h-a'), entry('old', 'id-o', 'h-o')] };
    const plan = computeReconcilePlan([entry('a', 'id-a', 'h-a')], current);
    expect(plan.toPrune.map(e => e.name)).toEqual(['old']);
  });
});
