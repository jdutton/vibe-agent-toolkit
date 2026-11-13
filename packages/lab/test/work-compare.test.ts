/**
 * `compareWork`: exact counter deltas, gated by each side's `stable` flag, with
 * the counters that are not deterministic reported and never compared exactly.
 *
 * The exactness table is pinned here in full, both ways: which counters a cache
 * mode compares exactly is one declaration, and a counter that silently moved
 * into or out of it would change what every comparison calls a finding.
 */

import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareWork, type WorkComparisonResult } from '../src/facets/work/compare.js';
import {
  comparedExactly,
  WORK_FACET,
  type WorkBody,
  type WorkCommandStats,
} from '../src/facets/work/types.js';

import { CLEAN_LOAD, makeReport } from './report-fixtures.js';
import { workCounters as counters, workRow as row } from './work-fixtures.js';

/** A report holding these rows. */
function report(commands: readonly WorkCommandStats[], body: Partial<WorkBody> & Record<string, unknown> = {}): ReportEnvelope<unknown> {
  return makeReport({ facet: WORK_FACET, body: { commands, load: CLEAN_LOAD, ...body } });
}

/** Compare one row against another and return that command's verdict. */
function verdictOf(before: WorkCommandStats, after: WorkCommandStats): WorkComparisonResult['commands'][number]['verdict'] {
  const result = compareWork(report([before]), report([after]));
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
  const [only] = result.commands;
  if (only === undefined) throw new Error('no command diffed');
  return only.verdict;
}

describe('comparedExactly', () => {
  const reportedOnly = (cache: 'warm' | 'cold'): WorkCounter[] =>
    WORK_COUNTER_NAMES.filter((name) => !comparedExactly(name, cache));

  it('warm: every counter but the load-dependent one is compared exactly', () => {
    expect(reportedOnly('warm')).toEqual(['parse.refused.load']);
  });

  it('cold: the parse cache counters are reported only, beside the load counter', () => {
    expect(reportedOnly('cold')).toEqual(['parse.cache.hit', 'parse.dispatched', 'parse.refused.load']);
  });
});

describe('compareWork', () => {
  it('calls identical rows unchanged', () => {
    expect(verdictOf(row(), row()).kind).toBe('unchanged');
  });

  it('calls a moved exact counter a change, with its exact delta', () => {
    const verdict = verdictOf(row(), row({ counters: counters({ 'store.rows.decoded.persistent': 121, 'git.calls': 2 }) }));
    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') return;
    expect(verdict.movement.counters).toEqual([
      { name: 'store.rows.decoded.persistent', kind: 'changed', count: { before: 120, after: 121, delta: 1 }, exact: true },
    ]);
  });

  it('reports a moved load counter but does not call it a change', () => {
    const verdict = verdictOf(
      row(),
      row({ counters: counters({ 'store.rows.decoded.persistent': 120, 'git.calls': 2, 'parse.refused.load': 3 }) }),
    );
    expect(verdict.kind).toBe('unchanged');
    if (verdict.kind !== 'unchanged') return;
    expect(verdict.movement.counters).toEqual([
      { name: 'parse.refused.load', kind: 'changed', count: { before: 0, after: 3, delta: 3 }, exact: false },
    ]);
  });

  it('in cold mode, does not call a moved parse.dispatched a change', () => {
    const verdict = verdictOf(
      row({ cache: 'cold', counters: counters({ 'parse.dispatched': 10 }) }),
      row({ cache: 'cold', counters: counters({ 'parse.dispatched': 12 }) }),
    );
    expect(verdict.kind).toBe('unchanged');
  });

  it('reports a counter on only one side as added or removed, and calls that a change', () => {
    const newer = row();
    const older = row({ counters: newer.counters.filter((reading) => reading.name !== 'git.calls') });
    const added = verdictOf(older, newer);
    const removed = verdictOf(newer, older);
    expect(added.kind).toBe('changed');
    expect(removed.kind).toBe('changed');
    if (added.kind !== 'changed' || removed.kind !== 'changed') return;
    expect(added.movement.counters).toEqual([
      { name: 'git.calls', kind: 'added', count: { before: 0, after: 2, delta: 2 }, exact: true },
    ]);
    expect(removed.movement.counters).toEqual([
      { name: 'git.calls', kind: 'removed', count: { before: 2, after: 0, delta: -2 }, exact: true },
    ]);
  });

  it.each([
    ['unstable', { stable: false }, /repeats disagreed/],
    ['untested', { stable: null, comparedRuns: 1 }, /never tested/],
  ] as const)('withholds the verdict when a side is %s', (_label, over, reason) => {
    const verdict = verdictOf(row(), row({ ...over, counters: counters({ 'git.calls': 9 }) }));
    expect(verdict.kind).toBe('unwarranted');
    if (verdict.kind !== 'unwarranted') return;
    expect(verdict.reason).toMatch(reason);
    expect(verdict.movement.counters.length).toBeGreaterThan(0);
  });

  it('refuses to subtract from a failed row', () => {
    const verdict = verdictOf(row(), row({ failed: true, failure: 'REFUSED: no cli dump', counters: [] }));
    expect(verdict).toEqual({ kind: 'unmeasurable', reason: 'the compared side row failed: REFUSED: no cli dump' });
  });

  it('refuses to compare rows taken under different cache modes', () => {
    const verdict = verdictOf(row(), row({ cache: 'cold' }));
    expect(verdict).toEqual({ kind: 'unmeasurable', reason: 'cache mode differs (warm vs cold)' });
  });

  it('reports a command on only one side as added or removed', () => {
    const result = compareWork(report([row()]), report([row({ name: 'validate' })]));
    if (!result.ok) throw new Error(result.refusal);
    expect(result.commands.map((diff) => [diff.name, diff.verdict.kind])).toEqual([
      ['resources-scan', 'removed'],
      ['validate', 'added'],
    ]);
  });

  it('refuses a report of another facet', () => {
    const io = makeReport({ facet: 'io', body: { commands: [], load: CLEAN_LOAD } });
    const result = compareWork(io, io);
    expect(result.ok).toBe(false);
  });

  it('refuses a body carrying a version field', () => {
    const result = compareWork(report([row()], { version: 1 }), report([row()]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatch(/^REFUSED: /);
  });
});
