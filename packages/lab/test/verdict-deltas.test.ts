/**
 * `reconcileDeltas` and `changelogRefusals` — pure, so every rule of the
 * committed deltas file is pinned here without spawning anything. The
 * end-to-end proof that a compare can fail is the planted-delta integration
 * suite; this file pins each rule on its own.
 */

import { describe, expect, it } from 'vitest';

import {
  changelogRefusals,
  headingAnchors,
  type ObservedDelta,
  parseVerdictDeltas,
  reconcileDeltas,
  type ReconcileRun,
  type VerdictDeltas,
} from '../src/facets/verdict/deltas.js';
import type { FindingKey } from '../src/facets/verdict/extract.js';

import { verdictDeltaEntryFactory } from './verdict-deltas-fixtures.js';

const ALIAS = 'crucible-1';
const VERB = 'audit';
const BASELINE = '0.2.0-rc.11';
const CHANGELOG_REF = '.changes/report-contract.md#audit-reports-a-report';
const REASON = 'audit now publishes a Report envelope';

const FINDING: FindingKey = { code: 'LINK_BROKEN', severity: 'error', location: 'docs/a.md', scope: null };

const RUN: ReconcileRun = {
  baseline: BASELINE,
  aliases: new Set([ALIAS]),
  verbsByAlias: new Map([[ALIAS, new Set([VERB])]]),
};

/**
 * @param entries - The declared entries
 * @param baseline - The file's baseline
 * @returns A deltas file
 */
function file(entries: VerdictDeltas['deltas'], baseline = BASELINE): VerdictDeltas {
  return { baseline, deltas: entries };
}

const entry = verdictDeltaEntryFactory({ subject: ALIAS, verb: VERB, changelog: CHANGELOG_REF, reason: REASON });

/**
 * @param change - The change observed on the default row
 * @returns An observed delta
 */
function observed(change: ObservedDelta['change']): ObservedDelta {
  return { subject: ALIAS, verb: VERB, change, detail: [] };
}

describe('reconcileDeltas — both ways', () => {
  it('reports an observed delta no entry declares as undeclared', () => {
    const result = reconcileDeltas([observed({ kind: 'exit', from: 0, to: 1 })], file([]), RUN);

    expect(result.undeclared.map((delta) => delta.change)).toEqual([{ kind: 'exit', from: 0, to: 1 }]);
    expect(result.unused).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  it('reports a declared delta nothing observed as unused', () => {
    const result = reconcileDeltas([], file([entry({ findingsAdded: [FINDING] })]), RUN);

    expect(result.unused.map((delta) => delta.change)).toEqual([{ kind: 'finding-added', finding: FINDING }]);
    expect(result.undeclared).toEqual([]);
  });

  it('accepts an exact declaration, item for item', () => {
    const result = reconcileDeltas(
      [observed({ kind: 'exit', from: 0, to: 1 }), observed({ kind: 'finding-added', finding: FINDING })],
      file([entry({ exit: { from: 0, to: 1 }, findingsAdded: [FINDING] })]),
      RUN,
    );

    expect(result).toEqual({ undeclared: [], unused: [], refusals: [] });
  });

  it('matches findings as a multiset — one of two declared duplicates occurring leaves one unused', () => {
    const result = reconcileDeltas(
      [observed({ kind: 'finding-added', finding: FINDING })],
      file([entry({ findingsAdded: [FINDING, FINDING] })]),
      RUN,
    );

    expect(result.unused).toHaveLength(1);
    expect(result.undeclared).toEqual([]);
  });

  it('does not let an unmeasured declaration excuse an exit move on the same row', () => {
    const result = reconcileDeltas(
      [observed({ kind: 'exit', from: 0, to: 2 }), observed({ kind: 'unmeasured' })],
      file([entry({ unmeasured: true })]),
      RUN,
    );

    expect(result.undeclared.map((delta) => delta.change)).toEqual([{ kind: 'exit', from: 0, to: 2 }]);
  });
});

describe('reconcileDeltas — every entry is validated, none filtered', () => {
  it('refuses a deltas file naming an alias the subject set does not define', () => {
    const result = reconcileDeltas([], file([entry({ subject: 'crucible-9', findingsAdded: [FINDING] })]), RUN);

    expect(result.refusals).toEqual([expect.stringContaining("names subject 'crucible-9'")]);
  });

  it('refuses a deltas file whose baseline is not the run baseline', () => {
    const result = reconcileDeltas([], file([], '0.2.0-rc.10'), RUN);

    expect(result.refusals).toEqual([expect.stringContaining("against baseline '0.2.0-rc.10'")]);
  });

  it('refuses an entry for a verb the alias did not run', () => {
    const result = reconcileDeltas([], file([entry({ verb: 'context-all', findingsAdded: [FINDING] })]), RUN);

    expect(result.refusals).toEqual([expect.stringContaining("names verb 'context-all'")]);
  });

  it('refuses an entry that declares nothing, and one that repeats a row', () => {
    const result = reconcileDeltas([], file([entry({}), entry({})]), RUN);

    expect(result.refusals).toEqual([
      expect.stringContaining('declares nothing'),
      expect.stringContaining('declares nothing'),
      expect.stringContaining('repeats an earlier entry'),
    ]);
  });
});

describe('changelogRefusals', () => {
  const declared = file([entry({ findingsAdded: [FINDING] })]);

  it('refuses a changelog anchor that no .changes fragment or CHANGELOG heading contains', () => {
    const sources = new Map([['.changes/report-contract.md', '# Report contract\n\n## Something else\n']]);

    expect(changelogRefusals(declared, sources)).toEqual([
      expect.stringContaining("no heading with anchor 'audit-reports-a-report'"),
    ]);
  });

  it('refuses a reference to a file that does not exist', () => {
    expect(changelogRefusals(declared, new Map())).toEqual([expect.stringContaining('does not exist')]);
  });

  it('accepts a reference whose heading exists (positive control)', () => {
    const sources = new Map([['.changes/report-contract.md', '### `audit` reports a `Report`\n']]);

    expect(changelogRefusals(declared, sources)).toEqual([]);
  });
});

describe('headingAnchors', () => {
  it('slugs headings GitHub-style and suffixes a repeat', () => {
    expect([...headingAnchors('# A b\n## A b\ntext # not\n####### seven\n#nospace\n')]).toEqual(['a-b', 'a-b-1']);
  });
});

describe('parseVerdictDeltas', () => {
  it('refuses a changelog reference outside .changes/ and CHANGELOG.md', () => {
    const result = parseVerdictDeltas({ baseline: BASELINE, deltas: [{ ...entry({}), changelog: 'README.md#x' }] });

    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('changelog') });
  });
});
