/**
 * The verdict facet's union mode: a "row" may be a SEQUENCE of rows, whose
 * findings are the union of its steps' documents, keyed by
 * `(code, location, line, severity)`. Coverage asks whether every key of one
 * union is in the other — bar 3's `union(B) ⊆ findings(C)`.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { changelogRefusals, type DeclaredUnionFinding, parseVerdictDeltas, type VerdictDeltas } from '../src/facets/verdict/deltas.js';
import { locationDigest } from '../src/facets/verdict/extract.js';
import type { VerdictBody, VerdictRow } from '../src/facets/verdict/types.js';
import { judgeUnion, type UnionArmEvidence, type UnionRequest, unionFindings } from '../src/facets/verdict/union.js';

/** A `Report<T>` row whose document carries these findings. */
function reportRow(name: string, findings: readonly Record<string, unknown>[], exitCode = 1): VerdictRow {
  return {
    name,
    argv: [name],
    outcome: 'exited',
    exitCode,
    spawnError: null,
    document: JSON.stringify({ status: 'findings', examined: 1, findings, summary: {}, data: {} }),
  };
}

const BROKEN = { code: 'LINK_BROKEN', severity: 'error', location: 'docs/a.md', line: 3, message: 'm' };
const SAME_FILE_OTHER_LINE = { ...BROKEN, line: 9 };
const SCHEMA = { code: 'FRONTMATTER_SCHEMA', severity: 'warning', location: 'docs/b.md', message: 'm' };

/** A body holding these rows. */
function body(rows: readonly VerdictRow[]): VerdictBody {
  return { arm: { set: {}, unset: [] }, rows, excluded: [], preparedClone: null };
}

describe('unionFindings', () => {
  it('unions the named rows’ findings, keyed by code, location, line and severity', () => {
    const union = unionFindings(body([reportRow('resources-validate-ci', [BROKEN, SAME_FILE_OTHER_LINE]), reportRow('resources-check-ci', [SCHEMA, BROKEN])]), [
      'resources-validate-ci',
      'resources-check-ci',
    ]);

    // The same finding from two steps is one key; the same code on another
    // line of the same file is another.
    expect(union).toEqual({
      ok: true,
      keys: [
        { code: 'FRONTMATTER_SCHEMA', location: 'docs/b.md', line: null, severity: 'warning' },
        { code: 'LINK_BROKEN', location: 'docs/a.md', line: 3, severity: 'error' },
        { code: 'LINK_BROKEN', location: 'docs/a.md', line: 9, severity: 'error' },
      ],
    });
  });

  it('refuses a name the body has no row for, rather than unioning fewer steps', () => {
    expect(unionFindings(body([reportRow('a', [])]), ['a', 'b'])).toEqual({
      ok: false,
      refusal: expect.stringContaining("'b'") as unknown,
    });
  });

  it('refuses a step that never ran, or whose document the lab cannot read — absent is never empty', () => {
    const notRun: VerdictRow = { ...reportRow('a', []), outcome: 'not-run', exitCode: null, spawnError: 'ENOENT' };
    const unreadable: VerdictRow = { ...reportRow('b', []), document: 'not a document' };

    expect(unionFindings(body([notRun]), ['a']).ok).toBe(false);
    expect(unionFindings(body([unreadable]), ['b']).ok).toBe(false);
  });

  it('refuses a step that exited 2, a run that did not complete', () => {
    expect(unionFindings(body([reportRow('a', [], 2)]), ['a']).ok).toBe(false);
  });
});

const PREPARED = { path: '/arms/run-1/clone', commit: 'c0ffee'.padEnd(40, '0') };

/** One subject's capture, run in the prepared clone at its commit unless overridden. */
function capture(
  rows: readonly VerdictRow[],
  overrides: { readonly preparedClone?: string | null; readonly commit?: string; readonly id?: string } = {},
): ReportEnvelope<VerdictBody> {
  const ranIn = overrides.preparedClone === undefined ? PREPARED.path : overrides.preparedClone;
  return {
    facet: 'verdict',
    coordinate: {
      subject: { id: overrides.id ?? 'app', source: ranIn ?? '/work/app' },
      subjectVersion: { kind: 'git', commit: overrides.commit ?? PREPARED.commit, ref: null, dirty: false, workingFingerprint: null },
      instrument: { version: '0.2.0', commit: null, dirty: null, closure: null },
    },
    capturedAt: '2026-10-31T00:00:00.000Z',
    removedEnv: [],
    body: { ...body(rows), preparedClone: ranIn },
  };
}

/** An arm's repetitions, each a list of step exits; the sequence exit is its first non-zero step's. */
function arm(name: string, repetitions: readonly (readonly (number | null)[])[]): UnionArmEvidence {
  return {
    name,
    repetitions: repetitions.map((exits) => ({
      exitCode: exits.find((exit) => exit !== 0) ?? 0,
      steps: exits.map((exitCode, index) => ({ name: `s${String(index)}`, exitCode })),
    })),
  };
}

const B_ROWS = ['resources-validate-ci', 'skills-validate-ci'];
const LEFT = capture([reportRow('resources-validate-ci', [BROKEN]), reportRow('skills-validate-ci', [], 0)]);
const RIGHT = capture([reportRow('validate', [BROKEN, SCHEMA])]);
const EXTRA = { code: SCHEMA.code, severity: 'warning', location: SCHEMA.location, line: null } as const;

/** A unions entry declaring these extras for the bar-3 pair. */
function declared(findingsAdded: readonly DeclaredUnionFinding[]): VerdictDeltas['unions'] {
  return [
    {
      subject: 'app',
      left: B_ROWS,
      right: ['validate'],
      findingsAdded: [...findingsAdded],
      changelog: 'CHANGELOG.md#x',
      reason: 'validate also runs the schema check',
    },
  ];
}

/** Bar 3 over these inputs: a clean pair unless overridden. */
function bar3(overrides: Partial<UnionRequest> = {}): ReturnType<typeof judgeUnion> {
  return judgeUnion({
    left: { envelope: LEFT, rows: B_ROWS },
    right: { envelope: RIGHT, rows: ['validate'] },
    arms: { prepared: PREPARED, left: arm('cand:ci-b:cold', [[0, 1], [0, 1]]), right: arm('cand:ci-c:cold', [[1], [1]]) },
    declared: declared([EXTRA]),
    ...overrides,
  });
}

describe('judgeUnion — bar 3, judged in one place', () => {
  it('passes when union(B) is covered, the extras are exactly the declared ones, and C exits as B first failed on every round', () => {
    expect(bar3()).toEqual({ ok: true, passed: true, missing: [], undeclared: [], unused: [], exitViolations: [] });
  });

  it('names every key of union(B) that C lacks — the same code on another line is another key', () => {
    const left = capture([reportRow('resources-validate-ci', [BROKEN, SAME_FILE_OTHER_LINE]), reportRow('skills-validate-ci', [], 0)]);

    expect(bar3({ left: { envelope: left, rows: B_ROWS } })).toMatchObject({
      ok: true,
      passed: false,
      missing: [{ code: 'LINK_BROKEN', location: 'docs/a.md', line: 9, severity: 'error' }],
    });
  });

  it("fails a round whose C exit is not B's first non-zero step exit — every repetition, not the first", () => {
    const result = bar3({ arms: { prepared: PREPARED, left: arm('cand:ci-b:cold', [[0, 1], [0, 0]]), right: arm('cand:ci-c:cold', [[1], [1]]) } });
    expect(result).toMatchObject({ ok: true, passed: false });
    expect(result.ok ? result.exitViolations : []).toEqual([
      "round 2: cand:ci-c:cold exited 1, but cand:ci-b:cold's first non-zero step exit is 0",
    ]);
  });

  it('fails a C exit of 2 even where B also exited 2 — a run that did not complete matches nothing', () => {
    const result = bar3({ arms: { prepared: PREPARED, left: arm('cand:ci-b:cold', [[2], [2]]), right: arm('cand:ci-c:cold', [[2], [2]]) } });
    expect(result.ok ? result.exitViolations : []).toEqual([
      'round 1: cand:ci-c:cold exited 2 — a run that did not complete is never a bar-3 exit',
      'round 2: cand:ci-c:cold exited 2 — a run that did not complete is never a bar-3 exit',
    ]);
  });

  it('refuses arms whose rounds cannot be paired, or a step that never exited', () => {
    expect(bar3({ arms: { prepared: PREPARED, left: arm('b', [[0, 1]]), right: arm('c', [[1], [1]]) } })).toEqual({
      ok: false,
      refusal: expect.stringContaining('1 round(s) of b against 2 of c') as unknown,
    });
    expect(bar3({ arms: { prepared: PREPARED, left: arm('b', []), right: arm('c', []) } }).ok).toBe(false);
    expect(bar3({ arms: { prepared: PREPARED, left: arm('b', [[0, null]]), right: arm('c', [[1]]) } }).ok).toBe(false);
  });

  it('fails an extra finding of C nobody declared, and a declared extra C did not produce — both ways', () => {
    expect(bar3({ declared: [] })).toMatchObject({ ok: true, passed: false, undeclared: [EXTRA], unused: [] });

    const other = { ...EXTRA, line: 4 };
    expect(bar3({ declared: declared([EXTRA, other]) })).toMatchObject({ ok: true, passed: false, undeclared: [], unused: [other] });
  });

  it('matches a declared extra named by location digest exactly as one named by path', () => {
    const byDigest = { code: EXTRA.code, severity: EXTRA.severity, locationDigest: locationDigest(SCHEMA.location), line: null };
    expect(bar3({ declared: declared([byDigest]) })).toMatchObject({ passed: true });
  });

  it('refuses two captures of different subjects or subject versions', () => {
    expect(bar3({ right: { envelope: capture([reportRow('validate', [])], { id: 'other' }), rows: ['validate'] } })).toEqual({
      ok: false,
      refusal: expect.stringContaining('subject') as unknown,
    });
    const moved = capture([reportRow('validate', [])], { commit: 'f'.repeat(40) });
    expect(bar3({ right: { envelope: moved, rows: ['validate'] } })).toEqual({
      ok: false,
      refusal: expect.stringContaining('subjectVersion') as unknown,
    });
  });

  it('refuses a capture that did not run in the prepared clone the arms ran in', () => {
    const unprepared = capture([reportRow('resources-validate-ci', [BROKEN]), reportRow('skills-validate-ci', [], 0)], { preparedClone: null });
    const unpreparedRight = capture([reportRow('validate', [BROKEN, SCHEMA])], { preparedClone: null });
    expect(bar3({ left: { envelope: unprepared, rows: B_ROWS }, right: { envelope: unpreparedRight, rows: ['validate'] } })).toEqual({
      ok: false,
      refusal: expect.stringContaining('not in the prepared clone') as unknown,
    });

    const elsewhere = { ...PREPARED, path: '/arms/run-2/clone' };
    expect(bar3({ arms: { prepared: elsewhere, left: arm('b', [[0, 1]]), right: arm('c', [[1]]) } })).toEqual({
      ok: false,
      refusal: expect.stringContaining("'/arms/run-2/clone'") as unknown,
    });
  });

  it('refuses a clone whose commit is not the one the arms were prepared at', () => {
    const atOther = { ...PREPARED, commit: 'a'.repeat(40) };
    expect(bar3({ arms: { prepared: atOther, left: arm('b', [[0, 1]]), right: arm('c', [[1]]) } })).toEqual({
      ok: false,
      refusal: expect.stringContaining(atOther.commit) as unknown,
    });
  });
});

describe('the deltas file’s unions section', () => {
  it('parses, defaults to none, and has its changelog references checked like every delta', () => {
    const parsed = parseVerdictDeltas({ baseline: '0.2.0', deltas: [], unions: declared([EXTRA]) });
    if (!parsed.ok) throw new Error(parsed.refusal);
    expect(parsed.deltas.unions).toHaveLength(1);
    expect(changelogRefusals(parsed.deltas, new Map([['CHANGELOG.md', '# none\n']]))).toEqual([
      expect.stringContaining('unions[0] (app)') as unknown,
    ]);

    const none = parseVerdictDeltas({ baseline: '0.2.0', deltas: [] });
    expect(none.ok ? none.deltas.unions : null).toEqual([]);
  });
});
