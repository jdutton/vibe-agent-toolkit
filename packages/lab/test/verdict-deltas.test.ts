/**
 * `reconcileDeltas` and `changelogRefusals` — pure, so every rule of the
 * committed deltas file is pinned here without spawning anything. The
 * end-to-end proof that a compare can fail is the planted-delta integration
 * suite; this file pins each rule on its own.
 */

import { describe, expect, it } from 'vitest';

import {
  bulletAnchors,
  changelogRefusals,
  type DeclaredFinding,
  type ObservedDelta,
  parseVerdictDeltas,
  reconcileDeltas,
  type ReconcileRun,
  type VerdictDeltas,
} from '../src/facets/verdict/deltas.js';
import { type FindingKey, locationDigest } from '../src/facets/verdict/extract.js';

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

describe('reconcileDeltas — findings: itemized', () => {
  it('accepts an itemized-findings declaration against the one delta compare observes for it', () => {
    const result = reconcileDeltas([observed({ kind: 'findings-itemized' })], file([entry({ findings: 'itemized' })]), RUN);

    expect(result).toEqual({ undeclared: [], unused: [], refusals: [] });
  });

  it('leaves the declaration unused, and every finding undeclared, when the counts did not match', () => {
    const result = reconcileDeltas(
      [observed({ kind: 'finding-added', finding: FINDING })],
      file([entry({ findings: 'itemized' })]),
      RUN,
    );

    expect(result.unused.map((delta) => delta.change)).toEqual([{ kind: 'findings-itemized' }]);
    expect(result.undeclared.map((delta) => delta.change.kind)).toEqual(['finding-added']);
  });

  it('parses `findings: itemized` and refuses any other value', () => {
    const declared = { subject: ALIAS, verb: VERB, changelog: CHANGELOG_REF, reason: REASON };
    expect(parseVerdictDeltas({ baseline: BASELINE, deltas: [{ ...declared, findings: 'itemized' }] }).ok).toBe(true);
    expect(parseVerdictDeltas({ baseline: BASELINE, deltas: [{ ...declared, findings: 'all' }] }).ok).toBe(false);
  });
});

describe('reconcileDeltas — a finding declared by the digest of its location', () => {
  const elsewhere: FindingKey = { ...FINDING, location: 'docs/b.md' };
  const digestOf = (finding: FindingKey): DeclaredFinding => ({
    code: finding.code,
    severity: finding.severity,
    locationDigest: locationDigest(finding.location ?? ''),
    scope: finding.scope,
  });
  const added = (finding: FindingKey): ObservedDelta => observed({ kind: 'finding-added', finding });

  it('accepts an added finding declared by its location digest, with no path in the file', () => {
    const declared = file([entry({ findingsAdded: [digestOf(FINDING)] })]);

    expect(JSON.stringify(declared)).not.toContain('docs/a.md');
    expect(reconcileDeltas([added(FINDING)], declared, RUN)).toEqual({ undeclared: [], unused: [], refusals: [] });
  });

  // I2: the same code, severity and COUNT at a different location must fail, both ways.
  it('fails both ways when the finding is at a different location than the digest names', () => {
    const result = reconcileDeltas([added(elsewhere)], file([entry({ findingsAdded: [digestOf(FINDING)] })]), RUN);

    expect(result.undeclared.map((delta) => delta.change)).toEqual([{ kind: 'finding-added', finding: elsewhere }]);
    expect(result.unused.map((delta) => delta.change)).toEqual([{ kind: 'finding-added', finding: digestOf(FINDING) }]);
  });

  it('matches a removed finding by digest too, and never an added one', () => {
    const declared = file([entry({ findingsRemoved: [digestOf(FINDING)] })]);

    expect(reconcileDeltas([observed({ kind: 'finding-removed', finding: FINDING })], declared, RUN)).toEqual({
      undeclared: [],
      unused: [],
      refusals: [],
    });
    expect(reconcileDeltas([added(FINDING)], declared, RUN).undeclared).toHaveLength(1);
  });

  it('refuses a digest that is not 64 hex characters, a finding naming both forms, and the retired by-code form', () => {
    const declared = { subject: ALIAS, verb: VERB, changelog: CHANGELOG_REF, reason: REASON };
    const parse = (extra: Record<string, unknown>): boolean => parseVerdictDeltas({ baseline: BASELINE, deltas: [{ ...declared, ...extra }] }).ok;
    const digest = digestOf(FINDING);

    expect(parse({ findingsAdded: [digest] })).toBe(true); // positive control
    expect(parse({ findingsAdded: [{ ...digest, locationDigest: 'abc' }] })).toBe(false);
    expect(parse({ findingsAdded: [{ ...digest, location: 'docs/a.md' }] })).toBe(false);
    expect(parse({ findingsAddedByCode: [{ code: 'LINK_BROKEN', severity: 'error', count: 1 }] })).toBe(false);
  });
});

describe('reconcileDeltas — a refusal move', () => {
  const moved = observed({ kind: 'refusal', from: [], to: ['RUN_INCOMPLETE', 'claude:RUN_INCOMPLETE'] });

  it('accepts the exact codes, in order, and nothing else', () => {
    const exact = file([entry({ refusal: { from: [], to: ['RUN_INCOMPLETE', 'claude:RUN_INCOMPLETE'] } })]);
    expect(reconcileDeltas([moved], exact, RUN)).toEqual({ undeclared: [], unused: [], refusals: [] });

    const other = reconcileDeltas([moved], file([entry({ refusal: { from: [], to: ['RUN_INCOMPLETE', 'claude:INTERNAL_ERROR'] } })]), RUN);
    expect(other.undeclared).toHaveLength(1);
    expect(other.unused).toHaveLength(1);
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

describe('changelogRefusals — a reference names one BULLET', () => {
  const declared = file([entry({ findingsAdded: [FINDING] })]);
  const MARKER = '<!-- verdict-delta:audit-reports-a-report -->';
  const sourcesOf = (text: string): Map<string, string> => new Map([['.changes/report-contract.md', text]]);

  it('accepts a reference whose id one bullet carries (positive control)', () => {
    expect(changelogRefusals(declared, sourcesOf(`### Breaking\n\n- **audit reports a Report.**\n  Detail. ${MARKER}\n- Another.\n`))).toEqual([]);
  });

  it('refuses an id no bullet carries — even when a HEADING slugs to it', () => {
    const headingOnly = '### audit reports a report\n\n- **audit reports a Report.**\n';

    expect(changelogRefusals(declared, sourcesOf(headingOnly))).toEqual([
      expect.stringContaining("no bullet carrying '<!-- verdict-delta:audit-reports-a-report -->'"),
    ]);
  });

  it('refuses an id that sits outside any bullet', () => {
    expect(changelogRefusals(declared, sourcesOf(`### Breaking\n${MARKER}\n\n- A bullet.\n`))).toEqual([
      expect.stringContaining('no bullet carrying'),
    ]);
  });

  it('refuses an id two bullets carry — a reference must name ONE', () => {
    expect(changelogRefusals(declared, sourcesOf(`- One. ${MARKER}\n- Two.\n  ${MARKER}\n`))).toEqual([
      expect.stringContaining('2 bullets carry'),
    ]);
  });

  it('refuses a reference to a file that does not exist', () => {
    expect(changelogRefusals(declared, new Map())).toEqual([expect.stringContaining('does not exist')]);
  });
});

describe('bulletAnchors', () => {
  it('counts each id once per bullet that carries it, continuation lines included, and nothing outside a bullet', () => {
    const text = [
      '### Breaking',
      '<!-- verdict-delta:stray -->',
      '- First bullet',
      '  continues. <!-- verdict-delta:first -->',
      '- Second <!-- verdict-delta:second --> and <!-- verdict-delta:second -->',
      '',
      '### Added',
      '- Third <!-- verdict-delta:first -->',
    ].join('\n');

    expect(bulletAnchors(text)).toEqual(new Map([['first', 2], ['second', 1]]));
  });
});

describe('parseVerdictDeltas', () => {
  it('refuses a changelog reference outside .changes/ and CHANGELOG.md, or one that is not an id', () => {
    const parse = (changelog: string): boolean => parseVerdictDeltas({ baseline: BASELINE, deltas: [{ ...entry({}), changelog }] }).ok;

    expect(parse(CHANGELOG_REF)).toBe(true); // positive control
    expect(parse('README.md#x')).toBe(false);
    expect(parse('.changes/report-contract.md#Some Heading')).toBe(false);
  });
});
