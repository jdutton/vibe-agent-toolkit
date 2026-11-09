/**
 * A check's own denominator: `examined` and `allowEmpty`.
 *
 * ## Why a check DECLARES it
 *
 * A check's statement selects its violations, so zero rows is the pass — and zero rows from a
 * check that looked at a thousand files and zero rows from one whose `WHERE` matched nothing are
 * the same answer. The run-level `examined` (members of the population) cannot tell them apart:
 * one check can match nothing while its neighbours see plenty. Only the author knows what the
 * check ranges over, so the check declares it as a second statement whose ROW COUNT is that
 * range — and an examined count of zero is refused unless the check says zero is legitimate.
 *
 * Pure: a fake `ask` keyed by statement, no disk, no database.
 */

import { CODE_REGISTRY, ExitCode, exitCodeForReport } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { ProgressEntry } from '../../src/commands/resources/check-progress.js';
import { CHECK_REPORT_SCHEMA } from '../../src/commands/resources/check-schema.js';
import { buildCheckOutputData, runProjectChecks } from '../../src/commands/resources/check.js';
import type { AskProjection } from '../../src/utils/projection-query.js';

const NAME = 'skills-have-owners';
const VIOLATIONS_SQL = 'SELECT path FROM skills WHERE owner IS NULL';
const EXAMINED_SQL = 'SELECT path FROM skills';
const EXAMINED_NOTHING = 'RESOURCE_CHECK_EXAMINED_NOTHING';
const BROKEN = 'RESOURCE_CHECK_BROKEN';

/** Rows the fake answers per statement; a statement it does not know is a defect in the case. */
type Answers = Readonly<Record<string, number | Error>>;

/**
 * An `ask` that answers each statement with its declared number of rows, or throws its error.
 *
 * @param answers - What each statement returns
 * @param asked - Where each statement asked is recorded, in order
 * @returns The fake
 */
function askFrom(answers: Answers, asked: string[] = []): AskProjection {
  return (sql) => {
    asked.push(sql);
    const answer = answers[sql];
    if (answer === undefined) throw new Error(`This fake declares no answer for: ${sql}`);
    if (answer instanceof Error) throw answer;
    return Array.from({ length: answer }, (_unused, index) => ({ path: `skills/${index}.md` }));
  };
}

/**
 * Run ONE declared check through the loop and the payload builder.
 *
 * @param check - The declaration's optional half
 * @param answers - What each statement returns
 * @returns The loop's own output, the published document, the statements asked and the progress
 */
function runOne(
  check: { examined?: string; allowEmpty?: true; severity?: 'warning' },
  answers: Answers,
  validation?: Parameters<typeof runProjectChecks>[0]['validation'],
): {
  costs: ReturnType<typeof runProjectChecks>['costs'];
  issues: ReturnType<typeof runProjectChecks>['issues'];
  published: Record<string, unknown>;
  report: ReturnType<typeof buildCheckOutputData>;
  asked: string[];
  progress: ProgressEntry[];
} {
  const asked: string[] = [];
  const progress: ProgressEntry[] = [];
  const { costs, issues } = runProjectChecks({
    builtins: [],
    checks: { [NAME]: { description: 'Every skill names an owner', sql: VIOLATIONS_SQL, ...check } },
    only: undefined,
    ask: askFrom(answers, asked),
    validation,
    membersEnumerated: 40,
    // Advances 5 ms per reading, so a statement's span is exactly 5.
    now: (() => {
      let reading = 0;
      return () => (reading += 5);
    })(),
    onProgress: (entry) => progress.push(entry),
  });
  const report = buildCheckOutputData({
    root: '/corpus',
    durationMs: 9,
    issues,
    costs,
    populated: {
      population: 'derived', lensPopulation: 'none', populationMs: 1, lensMs: 0, lensesEvaluated: [], membersEnumerated: 40,
    },
  });
  const published = (report.data.checks[0] ?? {}) as Record<string, unknown>;
  return { costs, issues, published, report, asked, progress };
}

describe('a check that declares what it examined', () => {
  it('runs the examined statement after the violations statement, and publishes its row count', () => {
    const { asked, published, issues } = runOne({ examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 2, [EXAMINED_SQL]: 17 });

    expect(asked).toStrictEqual([VIOLATIONS_SQL, EXAMINED_SQL]);
    expect(published).toMatchObject({ name: NAME, rows: 2, examined: 17 });
    expect(published).not.toHaveProperty('allowEmpty');
    expect(published).not.toHaveProperty('broken');
    expect(issues.map((issue) => issue.code)).toStrictEqual([`CUSTOM:${NAME}`, `CUSTOM:${NAME}`]);
  });

  it('charges BOTH statements to the check, and nothing else', () => {
    // Two spans of 5 on the fake clock: a cost of 5 would mean the examined statement went
    // unpriced; anything above 10 would mean the conversion was charged.
    const { costs } = runOne({ examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 2, [EXAMINED_SQL]: 17 });

    expect(costs[0]?.durationMs).toBe(10);
  });

  it('announces the examined statement BEFORE it runs, between the violations statement and the conversion', () => {
    const { progress } = runOne({ examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 2, [EXAMINED_SQL]: 17 });

    expect(progress.map((entry) => entry.kind)).toStrictEqual(['start', 'examining', 'converting', 'check', 'checks-complete']);
    expect(progress[1]).toStrictEqual({ kind: 'examining', name: NAME, durationMs: 5, rows: 2 });
    expect(progress[3]).toMatchObject({ kind: 'check', name: NAME, rows: 2, examined: 17 });
  });

  it('refuses an examined count of zero, and still reports the check\'s own violations', () => {
    const { published, issues, report } = runOne({ examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 1, [EXAMINED_SQL]: 0 });

    expect(published).toMatchObject({ rows: 1, examined: 0 });
    expect(published).not.toHaveProperty('allowEmpty');
    expect(published).not.toHaveProperty('broken');
    expect(issues.map((issue) => [issue.code, issue.severity])).toStrictEqual([
      [EXAMINED_NOTHING, 'error'],
      [`CUSTOM:${NAME}`, 'error'],
    ]);
    expect(issues[0]?.message).toContain(`"${NAME}"`);
    expect(issues[0]?.message).toContain('allowEmpty: true');
    expect(exitCodeForReport(report)).toBe(ExitCode.FINDINGS);
  });

  it('takes its severity, fix and reference from the code registry', () => {
    const { issues } = runOne({ examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 0, [EXAMINED_SQL]: 0 });
    const entry = CODE_REGISTRY[EXAMINED_NOTHING];

    expect(issues[0]).toMatchObject({ severity: entry.defaultSeverity, fix: entry.fix, reference: entry.reference, check: NAME });
  });

  it('accepts zero when the check declares allowEmpty, and publishes that it did', () => {
    const { published, issues, report } = runOne({ examined: EXAMINED_SQL, allowEmpty: true }, { [VIOLATIONS_SQL]: 0, [EXAMINED_SQL]: 0 });

    expect(published).toMatchObject({ rows: 0, examined: 0, allowEmpty: true });
    expect(issues).toStrictEqual([]);
    expect(exitCodeForReport(report)).toBe(ExitCode.OK);
  });

  it('publishes allowEmpty beside a non-zero count too, so the declaration is always visible', () => {
    const { published } = runOne({ examined: EXAMINED_SQL, allowEmpty: true }, { [VIOLATIONS_SQL]: 0, [EXAMINED_SQL]: 4 });

    expect(published).toMatchObject({ examined: 4, allowEmpty: true });
  });

  it('reports a failing examined statement as a broken check, with no examined count and none of its rows', () => {
    const { published, issues } = runOne(
      { examined: EXAMINED_SQL },
      { [VIOLATIONS_SQL]: 3, [EXAMINED_SQL]: new Error('no such table: skills') },
    );

    expect(published).toMatchObject({ rows: 3, broken: true });
    expect(published).not.toHaveProperty('examined');
    expect(issues.map((issue) => issue.code)).toStrictEqual([BROKEN]);
    expect(issues[0]?.message).toContain('examined statement');
    expect(issues[0]?.message).toContain('no such table: skills');
  });

  it('never runs the examined statement when the violations statement failed', () => {
    const { asked, published } = runOne({ examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: new Error('boom'), [EXAMINED_SQL]: 1 });

    expect(asked).toStrictEqual([VIOLATIONS_SQL]);
    expect(published).not.toHaveProperty('rows');
    expect(published).not.toHaveProperty('examined');
  });

  it('publishes no examined key at all for a check that declares none', () => {
    const { published, asked } = runOne({}, { [VIOLATIONS_SQL]: 0 });

    expect(asked).toStrictEqual([VIOLATIONS_SQL]);
    expect(published).not.toHaveProperty('examined');
    expect(published).not.toHaveProperty('allowEmpty');
  });

  it.each([
    ['nonzero', { examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 1, [EXAMINED_SQL]: 5 }],
    ['zero', { examined: EXAMINED_SQL }, { [VIOLATIONS_SQL]: 1, [EXAMINED_SQL]: 0 }],
    ['zero allowed', { examined: EXAMINED_SQL, allowEmpty: true as const }, { [VIOLATIONS_SQL]: 0, [EXAMINED_SQL]: 0 }],
  ])('builds a document its own published schema accepts (%s)', (_label, check, answers) => {
    const parsed = CHECK_REPORT_SCHEMA.safeParse(runOne(check, answers).report);
    expect(parsed.success ? [] : parsed.error.issues).toStrictEqual([]);
  });
});
