/**
 * The per-repetition provenance extractor, cell by cell.
 *
 * For every (build, arm, state) whose sequence rule reads a document field, one
 * synthetic correct run passes and its twin with that field removed FAILS:
 * "absent" is never a pass. The cells whose rule reads no document (every cold
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

/** rc.11 `resources check`, served from the store. */
const RC11_CHECK = report({ root: '.', population: 'store', populationSecs: 0.1, lensSecs: 0, lensesEvaluated: [] });

/**
 * The candidate's `validate`, every phase served from the store.
 *
 * Modelled AHEAD of S2: the resources phase's `data.population` is a field
 * today's `.strict()` resources-validate report schema cannot emit, so a real
 * candidate run reads as 'absent' here until S2 adds it. The CLI's report
 * schemas are internal to the CLI (and the lab measures several builds), so
 * this fixture cannot be parsed through the producer's schema.
 */
const CAND_VALIDATE = report({
  phases: [
    { name: 'resources', status: 'success', examined: 1, summary: {}, data: { population: 'store' } },
    { name: 'checks', status: 'success', examined: 1, summary: {}, data: { population: 'store', lensPopulation: 'none' } },
    { name: 'skills', status: 'success', examined: 1, summary: {}, data: {} },
  ],
});

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
    missing: report({ root: '.', populationSecs: 0.1 }),
  },
  {
    cell: 'cand-C-warm (validate; resources-phase population pending S2)',
    state: 'warm',
    reader: 'validate',
    correct: CAND_VALIDATE,
    missing: report({
      phases: [{ name: 'resources', status: 'success', examined: 1, summary: {}, data: {} }],
    }),
  },
];

describe('provenanceViolation — cells that read a document', () => {
  for (const cell of READ_CELLS) {
    it(`${cell.cell}: a correct run passes`, () => {
      expect(provenanceViolation('step', cell.reader, readProvenance(cell.reader, cell.correct), cell.state)).toBeNull();
    });

    it(`${cell.cell}: the run missing the field fails`, () => {
      expect(provenanceViolation('step', cell.reader, readProvenance(cell.reader, cell.missing), cell.state)).toMatch(
        /absent/,
      );
    });
  }

  it('fails a warm step whose population is derived, naming what it read', () => {
    const derived = RC11_CHECK.replace('"store"', '"derived"');
    expect(provenanceViolation('resources-check', 'resources-check', readProvenance('resources-check', derived), 'warm')).toMatch(
      /derived/,
    );
  });

  it('fails a warm step whose output is not a document at all', () => {
    expect(provenanceViolation('validate', 'validate', readProvenance('validate', 'not yaml: ['), 'warm')).toMatch(/absent/);
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
      expect(provenanceViolation('step', cell.reader, readProvenance(cell.reader, cell.stdout), cell.state)).toBeNull();
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
