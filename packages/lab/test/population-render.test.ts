/**
 * Rendering a population report and a population comparison.
 *
 * Three of these are the rules this facet can break in ways the others cannot:
 * a capped path list that does not say what it dropped renders a wholesale
 * divergence as a handful of files; a row whose lane is unknown renders as an
 * ordinary row while its arm is unproven; and two sides that ran the SAME lane
 * render as a clean result while comparing one enumerator with itself.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import type { PopulationComparisonResult } from '../src/facets/population/compare.js';
import {
  renderPopulationComparison,
  renderPopulationReport,
} from '../src/facets/population/render.js';
import {
  POPULATION_FACET,
  POPULATION_FACET_VERSION,
  type PopulationBody,
  type PopulationCommandStats,
} from '../src/facets/population/types.js';

import { CLEAN_LOAD, COORDINATE } from './report-fixtures.js';

const COMMAND = 'resources-population';

/** A measured row, with everything a case does not vary at a quiet default. */
function row(over: Partial<PopulationCommandStats> = {}): PopulationCommandStats {
  return {
    name: COMMAND,
    args: ['resources', 'scan', '.'],
    cache: 'warm',
    runs: 2,
    stable: true,
    attribution: 'measured',
    lane: 'walk',
    // The walk sources no extent, so `null` is its real value rather than a
    // stand-in — cases that need the projection's two enumerators override it.
    extentSource: null,
    root: '/fixture/project',
    count: 2,
    files: [
      { path: 'a.md', checksum: 'aaa' },
      { path: 'b.md', checksum: 'bbb' },
    ],
    gitTracked: 10,
    offGit: [],
    failed: false,
    failure: null,
    ...over,
  };
}

/** A report envelope carrying the given rows. */
function report(...commands: PopulationCommandStats[]): ReportEnvelope<PopulationBody> {
  return {
    formatVersion: 1,
    facet: POPULATION_FACET,
    facetVersion: POPULATION_FACET_VERSION,
    coordinate: COORDINATE,
    capturedAt: '2026-08-17T00:00:00.000Z',
    body: { commands, load: CLEAN_LOAD },
  };
}

/** A comparison carrying one command diff. */
function comparison(
  diff: PopulationComparisonResult['commands'][number],
): PopulationComparisonResult {
  return { ok: true, axis: null, commands: [diff], contaminated: false };
}

describe('renderPopulationReport', () => {
  it('states the count, the lane, the repeats and the git reference on one line', () => {
    const text = renderPopulationReport(report(row()));

    expect(text).toContain('2 files');
    expect(text).toContain('walk');
    expect(text).toContain('repeats agreed');
    expect(text).toContain('0 off-git of 10 tracked');
  });

  it('says the lane is UNREPORTED rather than leaving it blank', () => {
    // A blank would read as an ordinary row. It is a row whose arm is unproven.
    expect(renderPopulationReport(report(row({ lane: null })))).toContain('lane UNREPORTED');
  });

  it('shouts when the repeats disagreed', () => {
    expect(renderPopulationReport(report(row({ stable: false })))).toContain('REPEATS DISAGREED');
  });

  it('distinguishes "no git reference" from zero off-git findings', () => {
    const text = renderPopulationReport(report(row({ gitTracked: null })));

    expect(text).toContain('no git reference at this root');
    expect(text).not.toContain('off-git of');
  });

  it('renders a failed row as having no population, never as an empty one', () => {
    const text = renderPopulationReport(
      report(row({ failed: true, failure: 'the command printed no JSON document', count: 0, files: [] })),
    );

    expect(text).toContain('NO POPULATION');
    expect(text).toContain('printed no JSON document');
    expect(text).not.toContain('0 files (');
  });

  it('caps a long off-git list AND says how many it dropped', () => {
    const offGit = Array.from({ length: 25 }, (_, index) => `off-${String(index)}.md`);

    const text = renderPopulationReport(report(row({ offGit })));

    expect(text).toContain('off-git (25)');
    // The cap is 10, so 15 are unshown — and the line says so, because a cap
    // nobody is told about renders a wholesale divergence as a handful.
    expect(text).toContain('and 15 more');
    expect(text).toContain('off-0.md');
    expect(text).not.toContain('off-24.md');
  });
});

describe('renderPopulationComparison', () => {
  it('reports the three kinds of difference separately, and names the paths', () => {
    const text = renderPopulationComparison(
      comparison({
        name: COMMAND,
        verdict: { kind: 'changed', added: ['new.md'], removed: ['gone.md'], changed: ['moved.md'] },
        before: row({ lane: 'walk' }),
        after: row({ lane: 'projection' }),
      }),
    );

    expect(text).toContain('+1 / −1 / ~1 content');
    expect(text).toContain('only in compared');
    expect(text).toContain('new.md');
    expect(text).toContain('only in baseline');
    expect(text).toContain('gone.md');
    expect(text).toContain('same path, different content');
    expect(text).toContain('moved.md');
  });

  it('names both lanes when the two sides ran different enumerators', () => {
    const text = renderPopulationComparison(
      comparison({
        name: COMMAND,
        verdict: { kind: 'unchanged' },
        before: row({ lane: 'walk' }),
        after: row({ lane: 'projection' }),
      }),
    );

    expect(text).toContain('[walk → projection]');
  });

  it('WARNS when both sides ran the same lane, because that compares one lane with itself', () => {
    // The failure this facet exists to make visible: two runs of one enumerator
    // agree trivially, and without this the row reads as a clean result.
    const text = renderPopulationComparison(
      comparison({
        name: COMMAND,
        verdict: { kind: 'unchanged' },
        before: row({ lane: 'walk' }),
        after: row({ lane: 'walk' }),
      }),
    );

    expect(text).toContain("both sides ran the 'walk' arm");
    expect(text).toContain('compares one enumerator with itself');
  });

  it('distinguishes two arms that share a lane but differ in extent source', () => {
    // The gap this field closed. `VAT_EXTENT_SOURCE` is the axis the git-walker
    // flip turns on, and both of its arms report lane `projection` — so keyed
    // on the lane alone this pair rendered as "one enumerator compared with
    // itself" while it was in fact the exact comparison the caller wanted.
    const text = renderPopulationComparison(
      comparison({
        name: COMMAND,
        verdict: { kind: 'unchanged' },
        before: row({ lane: 'projection', extentSource: 'filesystem' }),
        after: row({ lane: 'projection', extentSource: 'git' }),
      }),
    );

    expect(text).toContain('[projection via filesystem → projection via git]');
    expect(text).not.toContain('compares one enumerator with itself');
  });

  it('WARNS when two projection arms share an extent source', () => {
    // The other direction, and the one that would void a flip measurement: a
    // switch that silently did nothing leaves both arms on `filesystem`, and
    // their agreement then says nothing at all.
    const text = renderPopulationComparison(
      comparison({
        name: COMMAND,
        verdict: { kind: 'unchanged' },
        before: row({ lane: 'projection', extentSource: 'filesystem' }),
        after: row({ lane: 'projection', extentSource: 'filesystem' }),
      }),
    );

    expect(text).toContain("both sides ran the 'projection via filesystem' arm");
  });

  it('renders a refusal to compare as its own outcome, not as no change', () => {
    const text = renderPopulationComparison(
      comparison({
        name: COMMAND,
        verdict: { kind: 'unmeasurable', reason: 'the baseline row failed: boom' },
        before: row({ failed: true }),
        after: row(),
      }),
    );

    expect(text).toContain('NO COMPARISON');
    expect(text).not.toContain('unchanged');
  });
});
