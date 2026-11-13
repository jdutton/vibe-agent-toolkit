/**
 * Every counted cost row in the hazard register maps to work counters or to an
 * unbuilt mechanism — exactly one of the two, both ways.
 *
 * Read from the tree, so an edit that moves, adds or restatuses a counted row
 * fails here until `work-counter-register.ts` is updated in the same change.
 */

import { readFileSync } from 'node:fs';

import { compareCodeUnits, resolveFromImportMeta, WORK_COUNTER_NAMES } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  COUNTED_COST_ROWS,
  countedRegisterRows,
  COUNTERS_WITHOUT_A_COUNTED_ROW,
  HAZARD_REGISTER_PATH,
  UNCOUNTED_COST_ROWS,
} from '../src/work-counter-register.js';

/** The counted rows as of the change that introduced the work counters. */
const EXPECTED_COUNTED_ROWS = [25, 32, 37, 45, 55, 56, 57, 58, 59, 60, 62, 70, 78];

const register = readFileSync(resolveFromImportMeta(import.meta.url, '..', '..', '..', HAZARD_REGISTER_PATH), 'utf-8');

/** @returns A map's keys as ascending numbers */
function rowsOf(map: Readonly<Record<number, unknown>>): number[] {
  return Object.keys(map).map(Number).sort((a, b) => a - b);
}

describe('the hazard register and the work counters', () => {
  it('has exactly the counted rows this change maps', () => {
    expect(countedRegisterRows(register)).toEqual(EXPECTED_COUNTED_ROWS);
  });

  it('maps every counted row to counters or to an unbuilt mechanism, and nothing else', () => {
    const mapped = [...rowsOf(COUNTED_COST_ROWS), ...rowsOf(UNCOUNTED_COST_ROWS)].sort((a, b) => a - b);
    expect(mapped).toEqual(countedRegisterRows(register));
  });

  it('never maps one row both ways', () => {
    const both = rowsOf(COUNTED_COST_ROWS).filter((row) => row in UNCOUNTED_COST_ROWS);
    expect(both).toEqual([]);
  });

  it('names only real counters, each against at most one row', () => {
    const named = Object.values(COUNTED_COST_ROWS).flat();
    expect(named.filter((counter) => !(WORK_COUNTER_NAMES as readonly string[]).includes(counter))).toEqual([]);
    expect(new Set(named).size).toBe(named.length);
  });

  it('accounts for every counter exactly once: against a row, or declared rowless', () => {
    const accounted = [...Object.values(COUNTED_COST_ROWS).flat(), ...Object.keys(COUNTERS_WITHOUT_A_COUNTED_ROW)];
    expect([...accounted].sort(compareCodeUnits)).toEqual([...WORK_COUNTER_NAMES].sort(compareCodeUnits));
  });

  it('reads the status column, not a word elsewhere on the row', () => {
    const rows = ['| h | accepted | text says accepted, counted |', '| h | accepted, counted | x |'].join('\n');
    expect(countedRegisterRows(rows)).toEqual([2]);
  });
});
