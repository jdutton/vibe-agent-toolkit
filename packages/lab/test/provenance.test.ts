/**
 * The per-repetition provenance extractor, cell by cell.
 *
 * For every (build, arm, state) whose sequence rule reads a document field, one
 * synthetic correct run passes and its twin with that ONE field removed — every
 * other byte of the document kept — FAILS: "absent" is never a pass, and a
 * reader that looked anywhere else would find the rest of the document intact. The cells whose rule reads no document (every cold
 * cell, and rc.11's arm A, whose verbs publish no population) are pinned to
 * assert nothing, so a reader added to them later is a visible change here.
 */

import { describe, expect, it } from 'vitest';

import { type ProvenanceReader, provenanceViolation, readProvenance } from '../src/harness/provenance.js';
import type { CacheMode } from '../src/harness/types.js';

/** A `Report<T>` envelope around `data`, as JSON — YAML is read the same way. */
function report(data: unknown): string {
  return JSON.stringify({ status: 'success', examined: 1, findings: [], summary: {}, data });
}

/**
 * @param data - A document's data, or one phase's
 * @returns The same with its `population` field removed, and nothing else changed
 */
function withoutPopulation(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'population'));
}

/** rc.11 `resources check`'s data, served from the store. */
const RC11_CHECK_DATA = { root: '.', population: 'store', populationSecs: 0.1, lensSecs: 0, lensesEvaluated: [] };
const RC11_CHECK = report(RC11_CHECK_DATA);

/**
 * The candidate's `validate`, every phase served from the store.
 *
 * Modelled AHEAD of S2: the resources phase's `data.population` is a field
 * today's `.strict()` resources-validate report schema cannot emit, so a real
 * candidate run reads as 'absent' here until S2 adds it. The CLI's report
 * schemas are internal to the CLI (and the lab measures several builds), so
 * this fixture cannot be parsed through the producer's schema.
 */
const CAND_VALIDATE_PHASES = [
  { name: 'resources', status: 'success', examined: 1, summary: {}, data: { population: 'store' } },
  { name: 'checks', status: 'success', examined: 1, summary: {}, data: { population: 'store', lensPopulation: 'none' } },
  { name: 'skills', status: 'success', examined: 1, summary: {}, data: {} },
] as const;
const CAND_VALIDATE = report({ phases: CAND_VALIDATE_PHASES });

/** One cell of the sequence-rule matrix: a step whose document the rule reads. */
interface Cell {
  readonly cell: string;
  readonly state: CacheMode;
  readonly reader: ProvenanceReader;
  readonly correct: string;
  readonly missing: string;
}

const READ_CELLS: readonly Cell[] = [
  {
    cell: 'rc11-B-warm (resources check)',
    state: 'warm',
    reader: 'resources-check',
    correct: RC11_CHECK,
    missing: report(withoutPopulation(RC11_CHECK_DATA)),
  },
  {
    cell: 'cand-C-warm (validate; resources-phase population pending S2)',
    state: 'warm',
    reader: 'validate',
    correct: CAND_VALIDATE,
    // Only the resources phase loses it: the checks phase still says 'store'.
    missing: report({
      phases: CAND_VALIDATE_PHASES.map((phase) => (phase.name === 'resources' ? { ...phase, data: withoutPopulation(phase.data) } : phase)),
    }),
  },
  {
    cell: 'cand-C-warm (validate; checks-phase population, S1 bar 4)',
    state: 'warm',
    reader: 'validate',
    correct: CAND_VALIDATE,
    // Only the checks phase loses it: the resources phase still says 'store'.
    missing: report({
      phases: CAND_VALIDATE_PHASES.map((phase) => (phase.name === 'checks' ? { ...phase, data: withoutPopulation(phase.data) } : phase)),
    }),
  },
];

/**
 * @param population - What the candidate's checks phase reports
 * @returns The candidate's `validate`, its resources phase from the store and its checks phase from `population`
 */
function checksFrom(population: string): ReturnType<typeof readProvenance> {
  return readProvenance(
    'validate',
    report({ phases: CAND_VALIDATE_PHASES.map((phase) => (phase.name === 'checks' ? { ...phase, data: { ...phase.data, population } } : phase)) }),
  );
}

describe('provenanceViolation — cells that read a document', () => {
  for (const cell of READ_CELLS) {
    it(`${cell.cell}: a correct run passes`, () => {
      expect(provenanceViolation('step', cell.reader, readProvenance(cell.reader, cell.correct), cell.state, true)).toBeNull();
    });

    it(`${cell.cell}: the run missing the field fails`, () => {
      expect(provenanceViolation('step', cell.reader, readProvenance(cell.reader, cell.missing), cell.state, true)).toMatch(
        /absent/,
      );
    });
  }

  it('fails a warm step whose population is derived, naming what it read', () => {
    const derived = RC11_CHECK.replace('"store"', '"derived"');
    expect(provenanceViolation('resources-check', 'resources-check', readProvenance('resources-check', derived), 'warm', true)).toMatch(
      /derived/,
    );
  });

  it('passes a warm store-off step whose population is derived, and fails one that claims the store', () => {
    const derived = readProvenance('resources-check', RC11_CHECK.replace('"store"', '"derived"'));
    const stored = readProvenance('resources-check', RC11_CHECK);
    expect(provenanceViolation('resources-check', 'resources-check', derived, 'warm', false)).toBeNull();
    expect(provenanceViolation('resources-check', 'resources-check', stored, 'warm', false)).toMatch(/turned the store off/u);
  });

  it("fails a warm validate whose CHECKS phase was derived though its resources phase came from the store", () => {
    expect(provenanceViolation('validate-ci', 'validate', checksFrom('derived'), 'warm', true)).toBe(
      "warm rule: step 'validate-ci' checks phase reports population 'derived', not 'store' — the arm is not warm",
    );
  });

  it("fails a warm store-off validate whose checks phase claims the store, and passes one that derived it", () => {
    const resourcesDerived = (provenance: ReturnType<typeof readProvenance>) => (provenance === null ? null : { ...provenance, resources: 'derived' });
    expect(provenanceViolation('validate-ci', 'validate', resourcesDerived(checksFrom('store')), 'warm', false)).toBe(
      "warm rule: step 'validate-ci' checks phase reports population 'store' though the arm turned the store off",
    );
    expect(provenanceViolation('validate-ci', 'validate', resourcesDerived(checksFrom('derived')), 'warm', false)).toBeNull();
  });

  it('fails a warm step whose output is not a document at all', () => {
    expect(provenanceViolation('validate', 'validate', readProvenance('validate', 'not yaml: ['), 'warm', true)).toMatch(/absent/);
  });
});

describe('provenanceViolation — cells that read nothing', () => {
  const NOTHING: ReadonlyArray<{ readonly cell: string; readonly state: CacheMode; readonly reader: ProvenanceReader; readonly stdout: string }> = [
    { cell: 'rc11-A-warm (resources validate, skills validate)', state: 'warm', reader: 'none', stdout: '' },
    { cell: 'rc11-A-cold (resources validate, skills validate)', state: 'cold', reader: 'none', stdout: '' },
    { cell: 'rc11-B-cold (resources check)', state: 'cold', reader: 'resources-check', stdout: '' },
    { cell: 'cand-C-cold (validate)', state: 'cold', reader: 'validate', stdout: '' },
  ];
  for (const cell of NOTHING) {
    it(`${cell.cell}: asserts no document field`, () => {
      expect(provenanceViolation('step', cell.reader, readProvenance(cell.reader, cell.stdout), cell.state, true)).toBeNull();
    });
  }
});

describe('readProvenance', () => {
  it("records the candidate's checks phase population and lensPopulation beside the resources phase", () => {
    expect(readProvenance('validate', CAND_VALIDATE)).toStrictEqual({ resources: 'store', checks: 'store', lens: 'none' });
  });

  it('records nothing for a step with no reader', () => {
    expect(readProvenance('none', CAND_VALIDATE)).toBeNull();
  });
});
