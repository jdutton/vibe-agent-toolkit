/**
 * The `work` facet's dump reader: what one vat process's work-counter dump may
 * look like, and how a repeat's dumps become one reading.
 *
 * The confident wrong numbers this guards against:
 *
 * - **A first-file reader.** A repeat can hold a `wrapper` dump beside the
 *   `cli` one, so the fixtures give the two processes DIFFERENT counts and the
 *   merge must report their sum, never either one.
 * - **A wrapper-only repeat.** The wrapper does almost no work, so a repeat
 *   whose CLI never wrote a dump would read as a command that decoded nothing.
 *   It is refused instead.
 * - **A hand-kept name list.** The names come from the utils tuple, so the real
 *   seam's own body must parse here — pinned against the bytes the seam builds,
 *   not against a fixture that merely looks like them.
 */

import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { __readWorkCounterDumpForTest } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { countOf, mergeWorkDumps, variedCounters, type WorkDump, WorkDumpSchema } from '../src/facets/work/dump.js';

/** A full counter record with every counter zero except those given. */
function counters(over: Partial<Record<WorkCounter, number>> = {}): Partial<Record<WorkCounter, number>> {
  return { ...Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, 0])), ...over };
}

/** Every counter at zero but one, which is absent: what an older vat writes. */
function countersWithout(missing: WorkCounter, over: Partial<Record<WorkCounter, number>> = {}): Partial<Record<WorkCounter, number>> {
  return Object.fromEntries(Object.entries(counters(over)).filter(([name]) => name !== missing));
}

/** One process's dump. */
function dump(role: WorkDump['role'], pid: number, over: Partial<Record<WorkCounter, number>> = {}): WorkDump {
  return { pid, role, counters: counters(over) };
}

describe('WorkDumpSchema', () => {
  it('accepts the body the real seam builds, for both roles', () => {
    expect(WorkDumpSchema.safeParse(__readWorkCounterDumpForTest('cli')).success).toBe(true);
    expect(WorkDumpSchema.safeParse(__readWorkCounterDumpForTest('wrapper')).success).toBe(true);
  });

  it('accepts a dump missing a counter, which is what an older vat writes', () => {
    expect(WorkDumpSchema.safeParse({ pid: 1, role: 'cli', counters: countersWithout('git.calls') }).success).toBe(true);
  });

  it.each([
    ['a counter this build does not know', { pid: 1, role: 'cli', counters: { ...counters(), 'store.rows.decoded.future': 1 } }],
    ['a negative count', { pid: 1, role: 'cli', counters: counters({ 'git.calls': -1 }) }],
    ['a fractional count', { pid: 1, role: 'cli', counters: counters({ 'git.calls': 1.5 }) }],
    ['an unknown role', { pid: 1, role: 'supervised-child', counters: counters() }],
    ['a version field', { pid: 1, role: 'cli', counters: counters(), version: 1 }],
    ['a missing pid', { role: 'cli', counters: counters() }],
  ])('refuses %s', (_label, value) => {
    expect(WorkDumpSchema.safeParse(value).success).toBe(false);
  });
});

describe('mergeWorkDumps', () => {
  it('sums every counter across processes', () => {
    const merged = mergeWorkDumps([
      dump('wrapper', 10, { 'git.calls': 1 }),
      dump('cli', 11, { 'git.calls': 4, 'store.rows.decoded.persistent': 120 }),
    ]);
    if (!merged.ok) throw new Error(merged.refusal);
    expect(merged.merged.processes).toBe(2);
    expect(countOf(merged.merged, 'git.calls')).toBe(5);
    expect(countOf(merged.merged, 'store.rows.decoded.persistent')).toBe(120);
    expect(countOf(merged.merged, 'extent.derived')).toBe(0);
  });

  it('reports counters in the utils tuple order, zeros included', () => {
    const merged = mergeWorkDumps([dump('cli', 11)]);
    if (!merged.ok) throw new Error(merged.refusal);
    expect(merged.merged.counters.map((reading) => reading.name)).toEqual([...WORK_COUNTER_NAMES]);
  });

  it('leaves out a counter no process reported, rather than inventing a zero', () => {
    const merged = mergeWorkDumps([{ pid: 1, role: 'cli', counters: countersWithout('git.calls') }]);
    if (!merged.ok) throw new Error(merged.refusal);
    expect(countOf(merged.merged, 'git.calls')).toBeUndefined();
  });

  it('refuses a repeat with no cli dump', () => {
    const merged = mergeWorkDumps([dump('wrapper', 10, { 'git.calls': 1 })]);
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.refusal).toMatch(/^REFUSED: .*no 'cli' dump/);
  });
});

describe('variedCounters', () => {
  it('names every counter whose count differs, and one present on only one side', () => {
    const left = mergeWorkDumps([dump('cli', 1, { 'git.calls': 2, 'extent.served': 1 })]);
    const older = countersWithout('content.hashed', { 'git.calls': 3, 'extent.served': 1 });
    const right = mergeWorkDumps([{ pid: 2, role: 'cli', counters: older }]);
    if (!left.ok || !right.ok) throw new Error('fixture refused');
    expect(variedCounters(left.merged, right.merged)).toEqual(['content.hashed', 'git.calls']);
  });

  it('is empty for identical readings', () => {
    const left = mergeWorkDumps([dump('cli', 1, { 'git.calls': 2 })]);
    const right = mergeWorkDumps([dump('cli', 2, { 'git.calls': 2 })]);
    if (!left.ok || !right.ok) throw new Error('fixture refused');
    expect(variedCounters(left.merged, right.merged)).toEqual([]);
  });
});
