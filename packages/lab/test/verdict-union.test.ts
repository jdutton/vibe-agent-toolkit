/**
 * The verdict facet's union mode: a "row" may be a SEQUENCE of rows, whose
 * findings are the union of its steps' documents, keyed by
 * `(code, location, line, severity)`. Coverage asks whether every key of one
 * union is in the other — bar 3's `union(B) ⊆ findings(C)`.
 */

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
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

/** B's build and C's build, as the captures' coordinates and the arms report's builds both name them. */
const RC11: InstrumentVersion = { version: '0.2.0-rc.11', commit: null, dirty: null, closure: 'a'.repeat(64) };
const CAND: InstrumentVersion = { version: '0.2.0', commit: null, dirty: null, closure: null };

/** One subject's capture, run in the prepared clone at its commit unless overridden. */
function capture(
  rows: readonly VerdictRow[],
  overrides: {
    readonly preparedClone?: string | null;
    readonly commit?: string;
    readonly id?: string;
    readonly instrument?: InstrumentVersion;
  } = {},
): ReportEnvelope<VerdictBody> {
  const ranIn = overrides.preparedClone === undefined ? PREPARED.path : overrides.preparedClone;
  return {
    facet: 'verdict',
    coordinate: {
      subject: { id: overrides.id ?? 'app', source: ranIn ?? '/work/app' },
      subjectVersion: { kind: 'git', commit: overrides.commit ?? PREPARED.commit, ref: null, dirty: false, workingFingerprint: null },
      instrument: overrides.instrument ?? CAND,
    },
    capturedAt: '2026-10-31T00:00:00.000Z',
    removedEnv: [],
    npmNetworkEnv: [],
    exits: [],
    body: { ...body(rows), preparedClone: ranIn },
  };
}

const B_ROWS = ['resources-validate-ci', 'skills-validate-ci'];
const C_ROWS = ['validate'];

/**
 * A timed arm: its repetitions, each a list of step exits (the sequence exit is
 * its first non-zero step's), its steps named by `rows`.
 */
function arm(
  name: string,
  repetitions: readonly (readonly (number | null)[])[],
  over: { readonly rows?: readonly string[]; readonly instrument?: InstrumentVersion; readonly failure?: string; readonly violation?: { readonly at: number; readonly why: string } } = {},
): UnionArmEvidence {
  const rows = over.rows ?? (name.includes('ci-b') ? B_ROWS : C_ROWS);
  return {
    name,
    instrument: over.instrument ?? (name.startsWith('rc11') ? RC11 : CAND),
    failure: over.failure ?? null,
    repetitions: repetitions.map((exits, index) => ({
      exitCode: exits.find((exit) => exit !== 0) ?? 0,
      violation: over.violation?.at === index ? over.violation.why : null,
      steps: exits.map((exitCode, step) => ({ name: rows[step] ?? `s${String(step)}`, timed: true, exitCode })),
    })),
  };
}

/** @returns `count` identical rounds of these step exits — five, the judged floor, unless told */
function rounds(exits: readonly (number | null)[], count = 5): (number | null)[][] {
  return Array.from({ length: count }, () => [...exits]);
}

const LEFT = capture([reportRow('resources-validate-ci', [BROKEN]), reportRow('skills-validate-ci', [], 0)], { instrument: RC11 });
const RIGHT = capture([reportRow('validate', [BROKEN, SCHEMA])]);
const EXTRA = { code: SCHEMA.code, severity: 'warning', location: SCHEMA.location, line: null } as const;

/** A unions entry declaring these extras (and, when given, C's exit move) for the bar-3 pair. */
function declared(findingsAdded: readonly DeclaredUnionFinding[], exit?: { readonly from: number; readonly to: number }): VerdictDeltas['unions'] {
  return [
    {
      subject: 'app',
      left: B_ROWS,
      right: C_ROWS,
      findingsAdded: [...findingsAdded],
      ...(exit === undefined ? {} : { exit }),
      changelog: 'CHANGELOG.md#x',
      reason: 'validate also runs the schema check',
    },
  ];
}

/** Bar 3 over these inputs: a clean pair unless overridden. */
function bar3(overrides: Partial<UnionRequest> = {}): ReturnType<typeof judgeUnion> {
  return judgeUnion({
    left: { envelope: LEFT, rows: B_ROWS },
    right: { envelope: RIGHT, rows: C_ROWS },
    arms: { prepared: PREPARED, left: arm('rc11:ci-b:cold', rounds([0, 1])), right: arm('cand:ci-c:cold', rounds([1])) },
    declared: declared([EXTRA]),
    ...overrides,
  });
}

/**
 * Bar 3 where both captures recorded the clone as `ranIn` and the arms report names it as `prepared`.
 *
 * @param ranIn - The captures' spelling
 * @param prepared - The arms report's spelling
 * @returns The judgement
 */
function inClone(ranIn: string, prepared: string): ReturnType<typeof judgeUnion> {
  const left = capture([reportRow('resources-validate-ci', [BROKEN]), reportRow('skills-validate-ci', [], 0)], { instrument: RC11, preparedClone: ranIn });
  const right = capture([reportRow('validate', [BROKEN, SCHEMA])], { preparedClone: ranIn });
  return bar3({
    left: { envelope: left, rows: B_ROWS },
    right: { envelope: right, rows: C_ROWS },
    arms: { prepared: { ...PREPARED, path: prepared }, left: arm('rc11:ci-b:cold', rounds([0, 1])), right: arm('cand:ci-c:cold', rounds([1])) },
  });
}

/** @returns Bar 3 over these two arms, everything else clean */
function bar3Arms(left: UnionArmEvidence, right: UnionArmEvidence): ReturnType<typeof judgeUnion> {
  return bar3({ arms: { prepared: PREPARED, left, right } });
}

describe('judgeUnion — bar 3, judged in one place', () => {
  it('passes when union(B) is covered, the extras are exactly the declared ones, and C exits as B first failed on every round', () => {
    expect(bar3()).toEqual({ ok: true, passed: true, missing: [], undeclared: [], unused: [], exitViolations: [] });
  });

  it('names every key of union(B) that C lacks — the same code on another line is another key', () => {
    const left = capture([reportRow('resources-validate-ci', [BROKEN, SAME_FILE_OTHER_LINE]), reportRow('skills-validate-ci', [], 0)], { instrument: RC11 });

    expect(bar3({ left: { envelope: left, rows: B_ROWS } })).toMatchObject({
      ok: true,
      passed: false,
      missing: [{ code: 'LINK_BROKEN', location: 'docs/a.md', line: 9, severity: 'error' }],
    });
  });

  it("fails a round whose C exit is not B's first non-zero step exit — every repetition, not the first", () => {
    const result = bar3Arms(arm('rc11:ci-b:cold', [...rounds([0, 1], 4), [0, 0]]), arm('cand:ci-c:cold', rounds([1])));
    expect(result).toMatchObject({ ok: true, passed: false });
    expect(result.ok ? result.exitViolations : []).toEqual([
      "round 5: cand:ci-c:cold exited 1, but rc11:ci-b:cold's first non-zero step exit is 0",
    ]);
  });

  it('fails a C exit of 2 even where B also exited 2 — a run that did not complete matches nothing', () => {
    const result = bar3Arms(arm('rc11:ci-b:cold', rounds([2, 0])), arm('cand:ci-c:cold', rounds([2])));
    expect(result.ok ? result.exitViolations : []).toHaveLength(5);
    expect(result.ok ? result.exitViolations[0] : '').toBe('round 1: cand:ci-c:cold exited 2 — a run that did not complete is never a bar-3 exit');
  });

  it('refuses arms whose rounds cannot be paired, or a step that never exited', () => {
    expect(bar3Arms(arm('rc11:ci-b:cold', rounds([0, 1])), arm('cand:ci-c:cold', rounds([1], 6)))).toEqual({
      ok: false,
      refusal: expect.stringContaining('5 round(s) of rc11:ci-b:cold against 6 of cand:ci-c:cold') as unknown,
    });
    expect(bar3Arms(arm('rc11:ci-b:cold', rounds([0, null])), arm('cand:ci-c:cold', rounds([1])))).toEqual({
      ok: false,
      refusal: expect.stringContaining('a step never exited') as unknown,
    });
  });

  it('refuses an arm that failed, or whose repetition broke its rule — a failed round is never read as complete', () => {
    const failed = arm('rc11:ci-b:cold', rounds([0, 1]), { failure: "1 of 5 repeats failed — step 'skills-validate-ci' exited 2" });
    expect(bar3Arms(failed, arm('cand:ci-c:cold', rounds([1])))).toEqual({
      ok: false,
      refusal: "rc11:ci-b:cold failed: 1 of 5 repeats failed — step 'skills-validate-ci' exited 2",
    });
    const violated = arm('cand:ci-c:cold', rounds([1]), { violation: { at: 2, why: 'the store is empty' } });
    expect(bar3Arms(arm('rc11:ci-b:cold', rounds([0, 1])), violated)).toEqual({
      ok: false,
      refusal: 'cand:ci-c:cold repetition 3 broke its rule: the store is empty',
    });
  });

  it('refuses arms of fewer than 5 repetitions — too few rounds to be a measurement', () => {
    expect(bar3Arms(arm('rc11:ci-b:cold', rounds([0, 1], 4)), arm('cand:ci-c:cold', rounds([1], 4)))).toEqual({
      ok: false,
      refusal: 'rc11:ci-b:cold has 4 repetition(s); a judged arm needs at least 5',
    });
  });

  it("refuses a capture whose build is not the named arm's build — the inputs must belong together", () => {
    const leftOnCand = capture([reportRow('resources-validate-ci', [BROKEN]), reportRow('skills-validate-ci', [], 0)], { instrument: CAND });
    expect(bar3({ left: { envelope: leftOnCand, rows: B_ROWS } })).toEqual({
      ok: false,
      refusal: expect.stringMatching(/^the left capture was measured with vat 0\.2\.0\b.*but rc11:ci-b:cold ran vat 0\.2\.0-rc\.11/u) as unknown,
    });
  });

  it("refuses --left/--right rows that are not the named arm's timed steps", () => {
    expect(bar3({ left: { envelope: LEFT, rows: ['resources-validate-ci'] } })).toEqual({
      ok: false,
      refusal: "the left rows are resources-validate-ci, but rc11:ci-b:cold's timed steps are resources-validate-ci, skills-validate-ci",
    });
    const otherSteps = arm('cand:ci-c:cold', rounds([1]), { rows: ['validate-ci'] });
    expect(bar3Arms(arm('rc11:ci-b:cold', rounds([0, 1])), otherSteps)).toEqual({
      ok: false,
      refusal: "the right rows are validate, but cand:ci-c:cold's timed steps are validate-ci",
    });
  });

  it("holds C's exit to B's AFTER a declared exit move, and fails the same move undeclared — both ways", () => {
    const passing = arm('cand:ci-c:cold', rounds([0]));
    const b = arm('rc11:ci-b:cold', rounds([0, 1]));

    expect(bar3({ arms: { prepared: PREPARED, left: b, right: passing }, declared: declared([EXTRA], { from: 1, to: 0 }) })).toMatchObject({
      ok: true,
      passed: true,
      exitViolations: [],
    });
    const undeclared = bar3({ arms: { prepared: PREPARED, left: b, right: passing } });
    expect(undeclared).toMatchObject({ ok: true, passed: false });
    expect(undeclared.ok ? undeclared.exitViolations[0] : '').toBe("round 1: cand:ci-c:cold exited 0, but rc11:ci-b:cold's first non-zero step exit is 1");
  });

  it("fails a declared exit move whose 'from' is not B's exit — a declaration that never applied is no excuse", () => {
    const result = bar3({ declared: declared([EXTRA], { from: 0, to: 1 }) });
    expect(result).toMatchObject({ ok: true, passed: false });
    expect(result.ok ? result.exitViolations[0] : '').toBe(
      "round 1: the unions entry moves C's exit from 0 to 1, but rc11:ci-b:cold's first non-zero step exit is 1",
    );
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
    expect(bar3({ arms: { prepared: elsewhere, left: arm('rc11:ci-b:cold', rounds([0, 1])), right: arm('cand:ci-c:cold', rounds([1])) } })).toEqual({
      ok: false,
      refusal: expect.stringContaining("'/arms/run-2/clone'") as unknown,
    });
  });

  it('accepts the prepared clone however its path is spelled — a trailing slash, a dot segment', () => {
    expect(inClone(PREPARED.path, PREPARED.path)).toMatchObject({ ok: true });
    expect(inClone(`${PREPARED.path}/`, PREPARED.path)).toMatchObject({ ok: true });
    expect(inClone(PREPARED.path.replace('/clone', '/./clone'), PREPARED.path)).toMatchObject({ ok: true });
  });

  it.runIf(process.platform === 'win32')('accepts the prepared clone with its drive letter in the other case', () => {
    const clone = normalizedTmpdir();
    const other = clone.replace(/^[A-Za-z]/u, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
    expect(inClone(other, clone)).toMatchObject({ ok: true });
  });

  it('refuses a clone whose commit is not the one the arms were prepared at', () => {
    const atOther = { ...PREPARED, commit: 'a'.repeat(40) };
    expect(bar3({ arms: { prepared: atOther, left: arm('rc11:ci-b:cold', rounds([0, 1])), right: arm('cand:ci-c:cold', rounds([1])) } })).toEqual({
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

  it('takes an exit move alone, and refuses an entry that declares neither findings nor an exit, or an exit to 2', () => {
    const [entry] = declared([], { from: 1, to: 0 });
    const exitOnly = parseVerdictDeltas({ baseline: '0.2.0', deltas: [], unions: [{ ...entry, findingsAdded: undefined }] });
    expect(exitOnly.ok ? exitOnly.deltas.unions[0]?.exit : exitOnly.refusal).toEqual({ from: 1, to: 0 });

    const empty = parseVerdictDeltas({ baseline: '0.2.0', deltas: [], unions: declared([]) });
    expect(empty.ok ? '' : empty.refusal).toMatch(/declares neither findingsAdded nor an exit/u);
    const toTwo = parseVerdictDeltas({ baseline: '0.2.0', deltas: [], unions: declared([], { from: 1, to: 2 }) });
    expect(toTwo.ok ? '' : toTwo.refusal).toMatch(/exit/u);
  });
});
