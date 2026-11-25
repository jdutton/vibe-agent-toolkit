/**
 * The edit rule's halves only the work dump and the clean arm show, and the
 * edit a report records as part of each edit arm's identity.
 */

import { describe, expect, it } from 'vitest';

import { editInputs } from '../src/facets/perf/arms-report-file.js';
import { type EditRuleInput, editRuleViolation } from '../src/facets/perf/arms.js';
import { MEASURABLE_SEQUENCES } from '../src/harness/commands.js';
import { editProvenanceViolation } from '../src/harness/sequence.js';

/**
 * @param resources - The resources population a step's document published
 * @returns That step's provenance
 */
function published(resources: string | null): { resources: string | null; checks: null; lens: null } {
  return { resources, checks: null, lens: null };
}

describe('editProvenanceViolation', () => {
  const ciB = MEASURABLE_SEQUENCES['ci-b'].steps;
  const ciC = MEASURABLE_SEQUENCES['ci-c'].steps;

  it('lets a later reader of the population the first step refilled from the edit report the store (ci-b)', () => {
    // resources validate (index 0) derived and wrote the store from the edited tree; resources check reads that store.
    expect(ciB[0]?.populates).toBe(true);
    expect(ciB[1]?.provenance).toBe('resources-check');
    expect(editProvenanceViolation(ciB, 1, published('store'))).toBeNull();
  });

  it('judges the first step that reads or fills a population: derived passes, store or absent fails (ci-c)', () => {
    expect(editProvenanceViolation(ciC, 0, published('derived'))).toBeNull();
    expect(editProvenanceViolation(ciC, 0, published('store'))).toMatch(/reports population 'store', not 'derived'/u);
    expect(editProvenanceViolation(ciC, 0, published(null))).toMatch(/published no resources population/u);
    expect(editProvenanceViolation(ciC, 0, null)).toMatch(/published no resources population/u);
  });
});

/**
 * @param reads - `store.reads.extent`
 * @param writes - `store.writes.persistent`
 * @param overrides - What the case varies besides the dump
 * @returns One edit repetition's reading
 */
function input(reads: number, writes: number, overrides: Partial<EditRuleInput> = {}): EditRuleInput {
  return {
    work: {
      processes: 1,
      counters: [
        { name: 'store.reads.extent', count: reads },
        { name: 'store.writes.persistent', count: writes },
      ],
    },
    workRefusal: null,
    exitCode: 0,
    cleanExit: 0,
    ...overrides,
  };
}

describe('editRuleViolation', () => {
  it('passes a repetition that read the extent, wrote the store and exited as the clean arm did', () => {
    expect(editRuleViolation(input(1, 1))).toBeNull();
  });

  it('fails a repetition whose dump shows no extent read or no store write', () => {
    expect(editRuleViolation(input(0, 1))).toMatch(/store\.reads\.extent 0 and store\.writes\.persistent 1/u);
    expect(editRuleViolation(input(1, 0))).toMatch(/store\.reads\.extent 1 and store\.writes\.persistent 0/u);
    expect(editRuleViolation({ ...input(1, 1), work: { processes: 1, counters: [] } })).toMatch(/extent 0 and .*persistent 0/u);
  });

  it('fails a repetition whose dumps cannot be read, naming why', () => {
    expect(editRuleViolation(input(1, 1, { work: null, workRefusal: 'no cli process wrote a dump' }))).toMatch(
      /work dumps cannot be read — no cli process wrote a dump/u,
    );
  });

  it("fails a repetition whose exit differs from the same build's clean arm in that round", () => {
    expect(editRuleViolation(input(1, 1, { exitCode: 1, cleanExit: 0 }))).toMatch(/exited 1, the same build's clean arm 0/u);
    // The clean arm has no repetition this round (its own failure says why): nothing to compare.
    expect(editRuleViolation(input(1, 1, { exitCode: 1, cleanExit: undefined }))).toBeNull();
  });
});

describe('editInputs', () => {
  it("records every edit arm's kind, count and --edit paths under its name, and nothing for other arms", () => {
    const arms = [
      { build: 'b', arm: 'ci-c', state: 'warm' as const },
      { build: 'b', arm: 'ci-c', state: { warm: 'edit' as const, count: 1, kind: 'delete' as const } },
    ];

    expect(editInputs(arms, ['docs/a.md'])).toEqual([{ arm: 'b:ci-c:warm-edit1:delete', kind: 'delete', count: 1, paths: ['docs/a.md'] }]);
    expect(editInputs(arms, null)).toEqual([{ arm: 'b:ci-c:warm-edit1:delete', kind: 'delete', count: 1, paths: null }]);
  });
});
