/**
 * Comparing two populations.
 *
 * The comparator is exact, so most of these cases are about the differences it
 * must NOT collapse: membership in each direction, and content at a path that
 * appears on both sides. A facet that reduced the three to one number would
 * report "0 differences" for two populations enumerating the same files with
 * different contents.
 *
 * The other half is refusal. A population that could not be read, or one that
 * enumerated nothing, must never be subtracted from a real one — that produces
 * "the entire corpus was removed", which is the most alarming possible rendering
 * of "the command found nothing".
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { comparePopulation } from '../src/facets/population/compare.js';
import {
  POPULATION_FACET,
  type PopulationCommandStats,
  type PopulationEntry,
} from '../src/facets/population/types.js';

import { CLEAN_LOAD, makeReport } from './report-fixtures.js';

const COMMAND = 'resources-population';

/** An rc.17 identity: the SHA-256 of the decoded text, a different scheme from a content key. */
function sum(value: string): PopulationEntry['identity'] {
  return { scheme: 'checksum', value };
}

/** A content-key identity, the scheme a current build reports. */
function key(value: string): PopulationEntry['identity'] {
  return { scheme: 'contentKey', value };
}

/** A measured row over the given files, with everything else at its quiet default. */
function row(
  files: readonly PopulationEntry[],
  over: Partial<PopulationCommandStats> = {},
): PopulationCommandStats {
  return {
    name: COMMAND,
    args: ['resources', 'scan', '.', '--verbose', '--format', 'json'],
    cache: 'warm',
    runs: 2,
    stable: true,
    attribution: files.length === 0 ? 'nothing-enumerated' : 'measured',
    extentSource: 'filesystem',
    root: '/fixture/project',
    count: files.length,
    files,
    gitTracked: 10,
    offGit: [],
    failed: false,
    failure: null,
    ...over,
  };
}

/** A `population` report carrying one row. */
function report(command: PopulationCommandStats): ReportEnvelope<unknown> {
  return makeReport({
    facet: POPULATION_FACET,
    body: { commands: [command], load: CLEAN_LOAD },
  });
}

const A: PopulationEntry = { path: 'a.md', identity: key('aaa') };
const B: PopulationEntry = { path: 'b.md', identity: key('bbb') };
const C: PopulationEntry = { path: 'c.md', identity: key('ccc') };

/**
 * Compare two populations and return the single command's verdict.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The verdict, or the refusal that stopped the comparison
 */
function verdictOf(
  before: PopulationCommandStats,
  after: PopulationCommandStats,
): Record<string, unknown> {
  const comparison = comparePopulation(report(before), report(after));
  expect(comparison.ok).toBe(true);
  if (!comparison.ok) throw new Error(comparison.refusal);
  const first = comparison.commands[0];
  expect(first).toBeDefined();
  return first?.verdict as unknown as Record<string, unknown>;
}

describe('comparePopulation', () => {
  it('reports identical populations as unchanged', () => {
    expect(verdictOf(row([A, B]), row([A, B]))).toEqual({ kind: 'unchanged' });
  });

  it('names the paths added and removed, in both directions at once', () => {
    expect(verdictOf(row([A, B]), row([A, C]))).toEqual({
      kind: 'changed',
      added: ['c.md'],
      removed: ['b.md'],
      changed: [],
      contentComparison: { kind: 'compared' },
    });
  });

  it('reports a content change at a path both sides enumerate', () => {
    // Invisible to a comparison of path lists, which is why this is its own
    // bucket rather than folded into added/removed.
    expect(verdictOf(row([A, B]), row([A, { path: 'b.md', identity: key('MOVED') }]))).toEqual({
      kind: 'changed',
      added: [],
      removed: [],
      changed: ['b.md'],
      contentComparison: { kind: 'compared' },
    });
  });

  it('keeps the three kinds of difference apart in one verdict', () => {
    const before = row([A, B]);
    const after = row([{ path: 'a.md', identity: key('MOVED') }, C]);

    expect(verdictOf(before, after)).toEqual({
      kind: 'changed',
      added: ['c.md'],
      removed: ['b.md'],
      changed: ['a.md'],
      contentComparison: { kind: 'compared' },
    });
  });

  it('REFUSES to subtract from a side that failed', () => {
    const verdict = verdictOf(
      row([], { failed: true, failure: 'the command reported no population', attribution: 'not-measured' }),
      row([A, B]),
    );

    expect(verdict.kind).toBe('unmeasurable');
    expect(String(verdict.reason)).toContain('baseline row failed');
  });

  it('REFUSES to subtract a real population from one that enumerated nothing', () => {
    // Without this the comparison reports the entire corpus as added, which
    // reads as a population explosion rather than as "the baseline found none".
    const verdict = verdictOf(row([]), row([A, B, C]));

    expect(verdict.kind).toBe('unmeasurable');
    expect(String(verdict.reason)).toContain('enumerated no files at all');
  });

  it('REFUSES two sides captured under different cache modes', () => {
    const verdict = verdictOf(row([A]), row([A], { cache: 'cold' }));

    expect(verdict.kind).toBe('unmeasurable');
    expect(String(verdict.reason)).toContain('cache mode differs');
  });

  it('refuses a report of another facet outright', () => {
    const comparison = comparePopulation(makeReport(), report(row([A])));

    expect(comparison.ok).toBe(false);
    if (comparison.ok) return;
    expect(comparison.refusal).toContain('REFUSED');
  });

  it('refuses a body written to an older shape', () => {
    // What a `facetVersion` integer used to sit in front of, done by the strict
    // schema instead: a body missing a field this build requires is refused for
    // the honest reason, and refused whether or not anyone remembered anything.
    const stale = makeReport({
      facet: POPULATION_FACET,
      body: { commands: [], load: { loadAvg1: 0.1, cpus: 8 } },
    });

    const comparison = comparePopulation(stale, report(row([A])));

    expect(comparison.ok).toBe(false);
    if (comparison.ok) return;
    expect(comparison.refusal).toMatch(/'population' report was captured by a lab whose report shape differs.*re-capture it/u);
  });

  describe('across identity schemes (an rc.17 baseline against a content-key candidate)', () => {
    const OLD_A: PopulationEntry = { path: 'a.md', identity: sum('aaa') };
    const OLD_B: PopulationEntry = { path: 'b.md', identity: sum('bbb') };

    it('does NOT report every path as changed: content is incomparable, with the reason stated', () => {
      expect(verdictOf(row([OLD_A, OLD_B]), row([A, B]))).toEqual({
        kind: 'content-incomparable',
        reason: expect.stringContaining('checksum') as unknown,
      });
    });

    it('still compares membership across schemes, and says content was not compared', () => {
      expect(verdictOf(row([OLD_A, OLD_B]), row([A, C]))).toEqual({
        kind: 'changed',
        added: ['c.md'],
        removed: ['b.md'],
        changed: [],
        contentComparison: { kind: 'incomparable', reason: expect.stringContaining('contentKey') as unknown },
      });
    });

    it('compares content when both sides carry the same scheme', () => {
      expect(verdictOf(row([OLD_A, OLD_B]), row([OLD_A, { path: 'b.md', identity: sum('MOVED') }]))).toEqual({
        kind: 'changed',
        added: [],
        removed: [],
        changed: ['b.md'],
        contentComparison: { kind: 'compared' },
      });
    });
  });
});
