/**
 * The structured half of `vat resources check`'s findings: which check a finding belongs to, the
 * evidence a violation's row carried, and `examinedNothing` on a check's entry.
 *
 * 🔑 A consumer of the document should not have to parse a message to learn which check spoke or
 * what its row said. `check` names the check on every finding a single check produced — its
 * violations and every refusal about it — and is ABSENT on a finding about the whole run.
 * `evidence` is a violation's row minus the reserved columns.
 *
 * Pure: a fake `ask`, no disk, no database.
 */

import type { BoundBuiltinCheck, ResourceCheck } from '@vibe-agent-toolkit/resources';
import { buildReport } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { ORCHESTRATOR_REPORT_SCHEMA } from '../../src/commands/orchestrator-schema.js';
import { orchestratorReport } from '../../src/commands/phase-utils.js';
import type { ProgressEntry } from '../../src/commands/resources/check-progress.js';
import { CHECK_REPORT_SCHEMA, type CheckReport } from '../../src/commands/resources/check-schema.js';
import {
  buildCheckOutputData,
  buildInterruptedCheckInput,
  runProjectChecks,
} from '../../src/commands/resources/check.js';
import { CommandRefusalError } from '../../src/utils/command-refusal.js';
import type { AskProjection, ColumnsOfStatement } from '../../src/utils/projection-query.js';
import { NO_COLUMNS } from '../helpers/no-columns.js';

/** The columns of a statement that selects `path` and a near miss of `finding_line`. */
const NEAR_COLUMNS: ColumnsOfStatement = () => ['path', 'Finding_Line'];

const EXAMINED_NOTHING = 'RESOURCE_CHECK_EXAMINED_NOTHING';
const BROKEN = 'RESOURCE_CHECK_BROKEN';
const POPULATED = {
  population: 'derived', lensPopulation: 'none', populationMs: 1, lensMs: 0, lensesEvaluated: [], membersEnumerated: 7,
} as const;

/**
 * An `ask` answering each statement with fixed rows, or throwing the error it is given.
 *
 * @param bySql - What each statement returns
 * @returns The fake
 */
function askRows(bySql: Readonly<Record<string, readonly Record<string, unknown>[] | Error>>): AskProjection {
  return (sql) => {
    const answer = bySql[sql];
    if (answer === undefined) throw new Error(`No rows declared for: ${sql}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

/**
 * Run the given checks and publish the document.
 *
 * @param checks - The declared checks
 * @param ask - The fake projection
 * @param options - Built-ins and the population size
 * @returns The document
 */
function publish(
  checks: Readonly<Record<string, ResourceCheck>>,
  ask: AskProjection,
  options: { builtins?: readonly BoundBuiltinCheck[]; membersEnumerated?: number; columnsOf?: ColumnsOfStatement } = {},
): CheckReport {
  const membersEnumerated = options.membersEnumerated ?? POPULATED.membersEnumerated;
  const { issues, costs } = runProjectChecks({
    columnsOf: options.columnsOf ?? NO_COLUMNS,
    builtins: options.builtins ?? [],
    checks,
    only: undefined,
    ask,
    validation: undefined,
    membersEnumerated,
  });
  return buildCheckOutputData({ root: '/corpus', durationMs: 3, issues, costs, populated: { ...POPULATED, membersEnumerated } });
}

/** The findings of a document, as plain records. */
function findingsOf(report: CheckReport): Record<string, unknown>[] {
  return report.findings as unknown as Record<string, unknown>[];
}

/**
 * Hold a document to its schema, reporting the schema's complaints rather than a bare `false`.
 *
 * @param report - The document
 */
function expectValid(report: CheckReport): void {
  const parsed = CHECK_REPORT_SCHEMA.safeParse(report);
  expect(parsed.success ? [] : parsed.error.issues).toStrictEqual([]);
}

/** The document a run killed by its budget publishes, rebuilt from the progress log `entries`. */
function interruptedReport(entries: readonly ProgressEntry[]): CheckReport {
  return buildCheckOutputData(buildInterruptedCheckInput({
    entries,
    root: '/corpus',
    ending: { kind: 'budget', budgetSecs: 2, invocation: 'standalone' },
    durationMs: 9,
  }));
}

/** Run `checks` over `answers`, then rebuild the document from their logged entries alone. */
function rebuiltFromLog(
  checks: Readonly<Record<string, ResourceCheck>>,
  answers: Parameters<typeof askRows>[0],
  columnsOf: ColumnsOfStatement = NO_COLUMNS,
): CheckReport {
  const progress: ProgressEntry[] = [];
  runProjectChecks({
    columnsOf,
    builtins: [],
    checks,
    only: undefined,
    ask: askRows(answers),
    validation: undefined,
    membersEnumerated: POPULATED.membersEnumerated,
    onProgress: (entry) => progress.push(entry),
  });
  return interruptedReport([{ kind: 'population', ...POPULATED }, ...progress.filter((entry) => entry.kind === 'check')]);
}

/**
 * Every pairing of a check entry's `examinedNothing` with the refusal naming that check — the two
 * must agree in BOTH directions.
 *
 * @param report - The document
 * @returns `[name, flagged, refused]` per check entry, and the refusals naming no entry
 */
function examinedNothingPairs(report: CheckReport): { pairs: [string, boolean, boolean][]; orphans: unknown[] } {
  const refusedNames = findingsOf(report).filter((finding) => finding['code'] === EXAMINED_NOTHING).map((finding) => finding['check']);
  const entries = report.data?.checks ?? [];
  const pairs = entries.map((entry): [string, boolean, boolean] => [
    entry.name,
    entry.examinedNothing === true,
    refusedNames.includes(entry.name),
  ]);
  const orphans = refusedNames.filter((name) => !entries.some((entry) => entry.name === name));
  return { pairs, orphans };
}

describe('a violation finding names its check and carries its row as evidence', () => {
  it('publishes check and evidence, keeps the message, and validates', () => {
    const report = publish(
      { owners: { description: 'Every skill names an owner', sql: 'V' } },
      askRows({ V: [{ path: 'skills/a.md', finding_line: 3, owner: null, severity: 'info', digest: new Uint8Array([7]) }] }),
    );

    expect(findingsOf(report)).toStrictEqual([{
      code: 'CUSTOM:owners',
      severity: 'error',
      message: 'Every skill names an owner — path=skills/a.md, finding_line=3, owner=null, severity=info, digest={"0":7}',
      location: 'skills/a.md',
      line: 3,
      check: 'owners',
      evidence: { owner: null, severity: 'info', digest: '{"0":7}' },
    }]);
    expectValid(report);
  });

  it('names a BUILT-IN check on its findings too, with no evidence', () => {
    const builtin: BoundBuiltinCheck = {
      name: 'claude-rule-glob-inert',
      run: () => [{ code: 'CLAUDE_RULE_GLOB_INERT', severity: 'info', message: 'inert', location: '.claude/rules/a.md' }],
    };
    const report = publish({}, askRows({}), { builtins: [builtin] });

    expect(findingsOf(report)).toStrictEqual([
      { code: 'CLAUDE_RULE_GLOB_INERT', severity: 'info', message: 'inert', location: '.claude/rules/a.md', check: 'claude-rule-glob-inert' },
    ]);
    expectValid(report);
  });
});

describe('a refusal about one check names that check', () => {
  it.each([
    ['a statement that threw', { sql: 'V' }, { V: new Error('no such column: x') }],
    ['rows it could not read', { sql: 'V' }, { V: [{ finding_severity: 'high' }] }],
    ['an examined statement that threw', { sql: 'V', examined: 'E' }, { V: [], E: new Error('no such table: t') }],
  ])('names it on %s', (_label, declared, answers) => {
    const report = publish({ bad: { description: 'd', ...declared } }, askRows(answers));

    expect(findingsOf(report).map((finding) => [finding['code'], finding['check']])).toStrictEqual([[BROKEN, 'bad']]);
    expectValid(report);
  });

  it('names it on an examined count of zero, beside its own violations', () => {
    const report = publish({ empty: { description: 'd', sql: 'V', examined: 'E' } }, askRows({ V: [{ n: 1 }], E: [{ n: 0 }] }));

    expect(findingsOf(report).map((finding) => [finding['code'], finding['check']])).toStrictEqual([
      [EXAMINED_NOTHING, 'empty'],
      ['CUSTOM:empty', 'empty'],
    ]);
    expectValid(report);
  });
});

describe('a finding about the whole run names no check', () => {
  it('leaves check off the empty-corpus refusal', () => {
    const report = publish({ a: { description: 'd', sql: 'V' } }, askRows({ V: [] }), { membersEnumerated: 0 });

    expect(findingsOf(report).map((finding) => [finding['code'], Object.hasOwn(finding, 'check')])).toStrictEqual([[BROKEN, false]]);
  });

  it('leaves check off the no-check-ran refusal', () => {
    const report = publish({}, askRows({}));

    expect(findingsOf(report).map((finding) => Object.hasOwn(finding, 'check'))).toStrictEqual([false]);
  });
});

describe('examinedNothing on a check entry agrees with the refusal, in both directions', () => {
  it.each([
    ['counted zero', { sql: 'V', examined: 'E' }, { V: [], E: [{ n: 0 }] }, true],
    ['counted some', { sql: 'V', examined: 'E' }, { V: [], E: [{ n: 1 }] }, false],
    ['zero, allowed', { sql: 'V', examined: 'E', allowEmpty: true as const }, { V: [], E: [{ n: 0 }] }, false],
    ['declares none', { sql: 'V' }, { V: [] }, false],
    ['examined threw', { sql: 'V', examined: 'E' }, { V: [], E: new Error('x') }, false],
    ['zero, rows unreadable', { sql: 'V', examined: 'E' }, { V: [{ finding_line: 0 }], E: [{ n: 0 }] }, false],
  ])('%s', (_label, declared, answers, expected) => {
    const report = publish({ c: { description: 'd', ...declared } }, askRows(answers));

    expect(examinedNothingPairs(report)).toStrictEqual({ pairs: [['c', expected, expected]], orphans: [] });
    // The key is absent, never `false`, when the check was not refused.
    expect(Object.hasOwn(report.data?.checks[0] ?? {}, 'examinedNothing')).toBe(expected);
    expectValid(report);
  });

  it('agrees on a run rebuilt from an interrupted child\'s progress log', () => {
    const entries: ProgressEntry[] = [
      { kind: 'population', ...POPULATED },
      { kind: 'check', name: 'zero', durationMs: 1, rows: 0, examined: 0 },
      { kind: 'check', name: 'some', durationMs: 1, rows: 0, examined: 4 },
      { kind: 'start', name: 'runaway' },
    ];
    const report = interruptedReport(entries);

    expect(examinedNothingPairs(report)).toStrictEqual({ pairs: [['zero', true, true], ['some', false, false]], orphans: [] });
    expectValid(report);
  });
});

describe('a killed run rebuilds the check entry a completed run publishes', () => {
  // A kill at either stage is compared with the completed run that BROKE at that stage.
  it.each([
    ['converting', { V: [{ finding_line: 0 }], E: [{ n: 1 }] }],
    ['examining', { V: [{ n: 1 }], E: new Error('no such table: t') }],
  ] as const)('while %s', (stage, answers) => {
    const progress: ProgressEntry[] = [];
    let reading = 0;
    const ran = runProjectChecks({
      columnsOf: NO_COLUMNS,
      builtins: [],
      checks: { c: { description: 'd', sql: 'V', examined: 'E', allowEmpty: true } },
      only: undefined,
      ask: askRows(answers),
      validation: undefined,
      membersEnumerated: POPULATED.membersEnumerated,
      now: () => (reading += 5),
      onProgress: (entry) => progress.push(entry),
    });
    const completed = buildCheckOutputData({ root: '/corpus', durationMs: 3, ...ran, populated: POPULATED });
    const killedAfter = progress.findIndex((entry) => entry.kind === stage);
    const rebuilt = interruptedReport([{ kind: 'population', ...POPULATED }, ...progress.slice(0, killedAfter + 1)]);

    // A kill mid-statement cannot know that statement's time; everything else must agree.
    const withoutTime = (report: CheckReport): unknown[] => (report.data?.checks ?? []).map(({ durationSecs: _t, ...entry }) => entry);
    expect(killedAfter).toBeGreaterThan(-1);
    expect(withoutTime(rebuilt)).toStrictEqual(withoutTime(completed));
    expectValid(rebuilt);
  });
});

describe('a check whose rows could not be read carries the reason as structure', () => {
  it('publishes column, value, row and what is allowed, and validates', () => {
    const report = publish({ graded: { description: 'd', sql: 'V' } }, askRows({ V: [{ n: 1 }, { finding_severity: 'high' }] }));

    expect(findingsOf(report)[0]?.['reason']).toStrictEqual({
      column: 'finding_severity', value: 'high', row: 2, allowed: 'one of error | warning | info',
    });
    expectValid(report);
  });

  it.each([
    ['a statement that threw', { sql: 'V' }, { V: new Error('no such column: x') }],
    ['an examined statement that threw', { sql: 'V', examined: 'E' }, { V: [], E: new Error('no such table: t') }],
  ])('carries no reason on %s', (_label, declared, answers) => {
    const report = publish({ bad: { description: 'd', ...declared } }, askRows(answers));

    expect(findingsOf(report).map((finding) => Object.hasOwn(finding, 'reason'))).toStrictEqual([false]);
  });
});

/** What `vat resources query` refuses a statement over a relation its run could not evaluate with. */
const LENS_REFUSED = new CommandRefusalError('INPUT_UNREADABLE', 'changed_files cannot be evaluated: no commits yet');

describe('a check over a relation its run could not evaluate keeps the relation\'s refusal code', () => {
  it.each([
    ['its violations statement', { sql: 'V' }, { V: LENS_REFUSED }],
    ['its examined statement', { sql: 'V', examined: 'E' }, { V: [], E: LENS_REFUSED }],
  ])('on %s', (_label, declared, answers) => {
    const report = publish({ scoped: { description: 'd', ...declared } }, askRows(answers));

    expect(findingsOf(report).map((finding) => [finding['code'], finding['reason']])).toStrictEqual([
      [BROKEN, { refusal: 'INPUT_UNREADABLE' }],
    ]);
    expectValid(report);
  });

  it('and a killed run rebuilds it from the progress log', () => {
    const rebuilt = rebuiltFromLog({ scoped: { description: 'd', sql: 'V' } }, { V: LENS_REFUSED });

    expect(findingsOf(rebuilt).find((finding) => finding['check'] === 'scoped')?.['reason']).toStrictEqual({ refusal: 'INPUT_UNREADABLE' });
    expectValid(rebuilt);
  });
});

describe('a near miss of a reserved column is published on its check\'s entry', () => {
  it('lists the column as the statement spelled it, beside the stderr warning', () => {
    const warnings: string[] = [];
    const ran = runProjectChecks({
      columnsOf: (sql) => (sql === 'V' ? ['path', 'Finding_Line'] : ['path']),
      builtins: [],
      checks: { near: { description: 'd', sql: 'V' }, clean: { description: 'd', sql: 'C' } },
      only: undefined,
      ask: askRows({ V: [{ path: 'a.md', Finding_Line: 3 }], C: [] }),
      validation: undefined,
      membersEnumerated: POPULATED.membersEnumerated,
      warn: (message) => warnings.push(message),
    });
    const report = buildCheckOutputData({ root: '/corpus', durationMs: 3, ...ran, populated: POPULATED });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Finding_Line"');
    // Absent, never `[]`, on a check without one.
    expect((report.data?.checks ?? []).map((entry) => [entry.name, entry.nearMisses])).toStrictEqual([
      ['near', ['Finding_Line']],
      ['clean', undefined],
    ]);
    expect(Object.hasOwn(report.data?.checks[1] ?? {}, 'nearMisses')).toBe(false);
    expectValid(report);
  });

  it('survives a killed run', () => {
    const rebuilt = rebuiltFromLog({ near: { description: 'd', sql: 'V' } }, { V: [{ path: 'a.md', Finding_Line: 3 }] }, NEAR_COLUMNS);

    expect(rebuilt.data?.checks[0]?.nearMisses).toStrictEqual(['Finding_Line']);
  });

  it.each([
    ['selected no row', { V: [] }],
    ['was broken by a row it could not read', { V: [{ path: 'a.md', Finding_Line: 3, finding_line: 0 }] }],
  ])('is read from the statement\'s columns, so it is published when the check %s', (_what, answers) => {
    const report = publish({ near: { description: 'd', sql: 'V' } }, askRows(answers), { columnsOf: NEAR_COLUMNS });

    expect(report.data?.checks[0]?.nearMisses).toStrictEqual(['Finding_Line']);
    expectValid(report);
  });

  it('is the same on a run killed after the statement, before its entry was filed', () => {
    const progress: ProgressEntry[] = [];
    runProjectChecks({
      columnsOf: NEAR_COLUMNS,
      builtins: [],
      checks: { near: { description: 'd', sql: 'V', examined: 'E' } },
      only: undefined,
      ask: askRows({ V: [], E: [{ n: 1 }] }),
      validation: undefined,
      membersEnumerated: POPULATED.membersEnumerated,
      onProgress: (entry) => progress.push(entry),
    });
    const killedWhileExamining = progress.slice(0, progress.findIndex((entry) => entry.kind === 'examining') + 1);

    const rebuilt = interruptedReport([{ kind: 'population', ...POPULATED }, ...killedWhileExamining]);

    expect(rebuilt.data?.checks[0]).toMatchObject({ name: 'near', broken: true, nearMisses: ['Finding_Line'] });
  });
});

describe('an interrupted run orders its findings as a completed run would', () => {
  it('puts an earlier check\'s refusal before the in-flight check\'s', () => {
    const entries: ProgressEntry[] = [
      { kind: 'population', ...POPULATED },
      { kind: 'start', name: 'first' },
      { kind: 'check', name: 'first', durationMs: 1, broken: true, refusal: { message: 'The check "first" could not run' } },
      { kind: 'start', name: 'second' },
      { kind: 'converting', name: 'second', durationMs: 2, rows: 1 },
    ];
    const report = interruptedReport(entries);

    expect(findingsOf(report).map((finding) => finding['check'])).toStrictEqual([undefined, 'first', 'second']);
    // One row is "1 row".
    expect(String(findingsOf(report)[2]?.['message'])).toContain('selected 1 row,');
  });
});

describe('an interrupted run\'s findings', () => {
  it('names the check stopped mid-conversion, and no check on the interruption itself', () => {
    const entries: ProgressEntry[] = [
      { kind: 'population', ...POPULATED },
      { kind: 'start', name: 'big' },
      { kind: 'converting', name: 'big', durationMs: 2, rows: 9 },
    ];
    const report = interruptedReport(entries);

    expect(findingsOf(report).map((finding) => finding['check'])).toStrictEqual([undefined, 'big']);
    expectValid(report);
  });
});

describe('the published schemas', () => {
  it('refuses a finding key the check schema does not declare', () => {
    const report = publish({ a: { description: 'd', sql: 'V' } }, askRows({ V: [{ n: 1 }] }));
    const tampered = { ...report, findings: report.findings.map((finding) => ({ ...finding, checkName: 'a' })) };

    expect(CHECK_REPORT_SCHEMA.safeParse(tampered).success).toBe(false);
  });

  it('lets vat validate publish the checks phase\'s findings unchanged, check and evidence included', () => {
    const phase = publish({ owners: { description: 'd', sql: 'V' } }, askRows({ V: [{ path: 'a.md', owner: null }] }));
    const folded = orchestratorReport([{ name: 'checks', report: phase }], { strict: false });

    expect(folded.findings).toStrictEqual(phase.findings);
    const parsed = ORCHESTRATOR_REPORT_SCHEMA.safeParse(folded);
    expect(parsed.success ? [] : parsed.error.issues).toStrictEqual([]);
  });

  it('still refuses evidence on an orchestrator finding that names no check', () => {
    const folded = buildReport({
      examined: 1,
      gate: { strict: false },
      data: { phases: [] },
      findings: [{ code: 'X', severity: 'error', message: 'm', evidence: { a: 1 } } as never],
    });

    expect(ORCHESTRATOR_REPORT_SCHEMA.safeParse(folded).success).toBe(false);
  });
});
