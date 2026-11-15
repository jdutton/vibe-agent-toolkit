/**
 * `vat resources query --budget`: the flag, the child's argv, and every way a supervised query can
 * end without its own document.
 *
 * The flag is read by the same functions `check` reads it with, so a value is refused identically
 * on both verbs; only the default differs (none, where `check` has 300 s). A supervised query that
 * did not finish has no answer wherever it stopped, so every ending is `RUN_INCOMPLETE`, exit 2,
 * and its message names the statement, never a check. The spawned half is proved in
 * `resources-query-budget.system.test.ts`.
 */

import { ExitCode, exitCodeForReport } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { ProgressEntry, UnitInFlight } from '../../src/commands/resources/check-progress.js';
import { type AbnormalDeath, interruptionMessage, type SupervisedRun } from '../../src/commands/resources/check-supervisor.js';
import { interruptedQueryRefusal, queryChildArgs, type QueryRequest } from '../../src/commands/resources/query-supervision.js';
import { querySupervisionOf } from '../../src/commands/resources/query.js';
import { NOTHING_FINISHED, refusalReport } from '../../src/utils/document-writer.js';

/** A `--supervised-by` value as this process's parent would have written it. */
const fromParent = (pid: number = process.ppid): string => `standalone:${String(pid)}:progress.jsonl`;

/** Says "check" or "checks" as a word: a query's wording must never. */
const NAMES_A_CHECK = /\bchecks?\b/i;

describe('querySupervisionOf — the flag, refused exactly as `check` refuses it', () => {
  it('has no bound when the flag is omitted, and `--budget 0` is the same thing', () => {
    expect(querySupervisionOf({})).toStrictEqual({ budgetSecs: 0, child: undefined });
    expect(querySupervisionOf({ budget: '0' })).toStrictEqual({ budgetSecs: 0, child: undefined });
  });

  it('takes the operator\'s number, fractions included', () => {
    expect(querySupervisionOf({ budget: '2' }).budgetSecs).toBe(2);
    expect(querySupervisionOf({ budget: '0.5' }).budgetSecs).toBe(0.5);
  });

  it.each([
    ['blank', ''],
    ['whitespace', ' \t'],
    ['not a number', 'soon'],
    ['negative', '-1'],
    ['an exponent that underflows to zero', '1e-400'],
    ['negative zero', '-0'],
  ])('refuses a value that is %s, as USAGE_INVALID naming --budget', (_label, raw) => {
    expect(() => querySupervisionOf({ budget: raw })).toThrow(/--budget/);
    try {
      querySupervisionOf({ budget: raw });
    } catch (error) {
      expect((error as { refusal?: string }).refusal).toBe('USAGE_INVALID');
    }
  });

  it('refuses a positive --budget beside --supervised-by', () => {
    expect(() => querySupervisionOf({ budget: '60', supervisedBy: fromParent() }))
      .toThrow(/--budget cannot be combined with --supervised-by/);
  });

  it('refuses a --supervised-by this process\'s parent did not hand it', () => {
    expect(() => querySupervisionOf({ supervisedBy: fromParent(process.ppid + 1) }))
      .toThrow(/was not spawned by the supervisor it names/);
  });

  it('reads the --supervised-by its parent did hand it, as the child it is', () => {
    expect(querySupervisionOf({ supervisedBy: fromParent() })).toStrictEqual({
      budgetSecs: 0,
      child: { invoker: 'standalone', supervisorPid: process.ppid, progressLog: 'progress.jsonl' },
    });
  });
});

describe('queryChildArgs', () => {
  const request: QueryRequest = {
    sql: '-- a comment first\nSELECT ?',
    parameters: ['-1', 'x=y'],
    root: '/the/root',
    base: 'origin/main',
    debug: true,
    format: 'json',
    budgetSecs: 5,
  };

  it('passes every value as --name=value, and the statement and root last, after --', () => {
    // A statement opening with a `--` comment, or a parameter beginning with `-`, would otherwise
    // read as an option in the child.
    expect(queryChildArgs(request, '/log/progress.jsonl')).toStrictEqual([
      'resources',
      'query',
      '--format=json',
      '--debug',
      '--base=origin/main',
      '--param=-1',
      '--param=x=y',
      '--supervised-by',
      `standalone:${String(process.pid)}:/log/progress.jsonl`,
      '--',
      '-- a comment first\nSELECT ?',
      '/the/root',
    ]);
  });

  it('never hands the child --budget: the child is bounded by its parent, not by itself', () => {
    const args = queryChildArgs({ ...request, debug: false, base: undefined, parameters: [] }, 'p');

    expect(args.map((arg) => arg.split('=')[0])).not.toContain('--budget');
    expect(args).not.toContain('--debug');
    expect(args.some((arg) => arg.startsWith('--base'))).toBe(false);
  });
});

/** Every state the progress log can be read as. */
const IN_FLIGHT: ReadonlyArray<readonly [string, UnitInFlight]> = [
  ['startup', { kind: 'startup' }],
  ['population', { kind: 'population' }],
  ['idle', { kind: 'idle' }],
  ['reporting', { kind: 'reporting' }],
  ['check', { kind: 'check', name: 'n' }],
  ['examining', { kind: 'examining', name: 'n', rows: 1 }],
  ['converting', { kind: 'converting', name: 'n', rows: 1 }],
];

/** Every way a child can die that is not the watchdog's kill. */
const DEATHS: ReadonlyArray<readonly [string, AbnormalDeath]> = [
  ['a fatal abort', { kind: 'signal', signal: 'SIGABRT' }],
  ['an outside SIGKILL', { kind: 'signal', signal: 'SIGKILL' }],
  ['a spawn that failed', { kind: 'spawn-failed', binary: 'vat.js', detail: 'spawn ENOENT' }],
  ['a command line too long', { kind: 'spawn-failed', binary: 'vat.js', detail: 'spawn E2BIG' }],
  ['a refused kill', { kind: 'kill-failed', detail: 'EPERM', pid: 77, refused: true }],
  ['an accepted kill that did not land', { kind: 'kill-failed', detail: 'accepted', pid: 77, refused: false }],
  ['no status at all', { kind: 'no-status' }],
  ['a heap abort with no output', { kind: 'no-output', code: 134 }],
  ['an exit with no output', { kind: 'no-output', code: 3 }],
];

describe('interruptionMessage — every unit in flight, every way a query can end', () => {
  it.each(IN_FLIGHT.flatMap(([unit, inFlight]) => DEATHS.map(([death, value]) => [unit, death, inFlight, value] as const)))(
    'in %s, of %s: a death with no answer, and no check named',
    (_unit, _death, inFlight, death) => {
      const message = interruptionMessage(inFlight, { kind: 'abnormal', death, invocation: 'query' });

      expect(message).toContain('so there is no answer');
      expect(message).not.toMatch(NAMES_A_CHECK);
    },
  );

  it.each(IN_FLIGHT)('in %s, of an exit that disagrees with its document: the contradiction, and no check named', (_unit, inFlight) => {
    // The one death that is not "died before it finished": the child DID finish, and its exit
    // contradicts its own document, so the document is withheld rather than forwarded.
    const message = interruptionMessage(inFlight, {
      kind: 'abnormal', death: { kind: 'exit-disagrees', code: 3, documentExit: 0 }, invocation: 'query',
    });

    expect(message).toContain('exit contradicts its own report');
    expect(message).not.toMatch(NAMES_A_CHECK);
  });

  it.each(IN_FLIGHT)('in %s, killed at the limit: the bound and how to change it, and no check named', (_unit, inFlight) => {
    const message = interruptionMessage(inFlight, { kind: 'budget', budgetSecs: 7, invocation: 'query' });

    expect(message).toContain('This run made no progress for 7s and was killed');
    expect(message).toContain('omit `--budget` to run unbounded');
    expect(message).not.toMatch(NAMES_A_CHECK);
  });

  it('is a pattern that does see a check: the same ending, run by `check`, names one', () => {
    // The positive control for every `not.toMatch` above.
    const message = interruptionMessage({ kind: 'idle' }, { kind: 'budget', budgetSecs: 7, invocation: 'standalone' });

    expect(message).toMatch(NAMES_A_CHECK);
  });

  it('names --budget 0 for a command line the platform would not take', () => {
    const message = interruptionMessage({ kind: 'startup' }, {
      kind: 'abnormal', death: { kind: 'spawn-failed', binary: 'vat.js', detail: 'spawn E2BIG' }, invocation: 'query',
    });

    expect(message).toContain('`--budget 0`');
  });
});

/** The progress log a child left, from its entries. */
const logOf = (...entries: readonly ProgressEntry[]): string => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

const POPULATED: ProgressEntry = {
  kind: 'population', population: 'derived', lensPopulation: 'none', populationMs: 1, lensMs: 0, lensesEvaluated: [], membersEnumerated: 1,
};

describe('interruptedQueryRefusal — what a supervised query publishes when it did not finish', () => {
  it.each([
    ['a child that never started', '', 'before the child process had finished starting'],
    ['a population that never finished', logOf({ kind: 'started' }), 'before its population completed'],
    ['a statement that never returned', logOf({ kind: 'started' }, POPULATED), 'while the statement was running'],
    ['an answer being written', logOf({ kind: 'started' }, POPULATED, { kind: 'statements-complete' }), 'while its answer was being written'],
  ])('%s: RUN_INCOMPLETE, exit 2, naming where it stopped', (_label, log, where) => {
    const runs: ReadonlyArray<Exclude<SupervisedRun, { outcome: 'completed' }>> = [
      { outcome: 'killed', log, elapsedMs: 9 },
      { outcome: 'abnormal', death: { kind: 'signal', signal: 'SIGABRT' }, log, elapsedMs: 9 },
    ];
    for (const run of runs) {
      const refusal = interruptedQueryRefusal(run, 3);
      const report = refusalReport(refusal.refusal, refusal, { strict: false }, NOTHING_FINISHED);

      expect(refusal.refusal).toBe('RUN_INCOMPLETE');
      expect(exitCodeForReport(report)).toBe(ExitCode.ERROR);
      expect(refusal.message).toContain(where);
      expect(refusal.message).not.toMatch(NAMES_A_CHECK);
    }
  });
});
