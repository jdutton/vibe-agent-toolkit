/**
 * The arguments `vat validate`'s `checks` phase hands its supervised `vat resources check` child.
 *
 * Observed at the supervisor's door: `superviseCheck` is replaced by a recorder, so the argv the
 * phase composes is read exactly as the spawn would receive it, with no process started — and
 * `withProgressLog` by one that hands over a path (and a guard that guards nothing) without minting a directory, so this unit test
 * touches no filesystem. The contract: the operand is the root the orchestrator resolved,
 * `--format json` (the phase reads the child's document as JSON), `--debug` iff the orchestrator
 * was given it, `--supervised-by phase:<this pid>:<log>` (the recursion guard; `phase` because the
 * child owes no notice its orchestrator already printed) — and never `--check` (a phase runs every check) or
 * `--verbose` (the phase reports the child's findings on stderr itself, at the orchestrator's verbosity).
 *
 * ⚠️ That the child then checks exactly that root is observed through the real binary only for
 * `vat resources check` (the nested-project case in `validate-checks-phase-faults.system.test.ts`):
 * under `vat validate` the child inherits the orchestrator's working directory, whose project IS
 * the root, so a dropped operand would go unnoticed there. This argv is the pin.
 */

import type { Report } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SupervisorModule from '../../src/commands/resources/check-supervisor.js';
import { NO_COLUMNS } from '../helpers/no-columns.js';
import { captureProcessExit } from '../test-doubles.js';

const recorded: Array<readonly string[]> = [];

/** The progress log the stand-in `withProgressLog` hands over — never created. */
const PROGRESS_LOG = safePath.join('/minted-by-the-supervisor', 'progress.jsonl');

/** A whole report, so the phase forwards it instead of rebuilding one — built from `check.js` once it is imported. */
const forwarded: { report?: Report<unknown> } = {};

vi.mock('../../src/commands/resources/check-supervisor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SupervisorModule>()),
  superviseCheck: vi.fn((options: { args: readonly string[] }): Promise<SupervisorModule.SupervisedRun> => {
    recorded.push(options.args);
    const report = forwarded.report;
    if (report === undefined) throw new Error('the forwarded report was not built yet');
    return Promise.resolve({ outcome: 'completed', document: { text: JSON.stringify(report), report } });
  }),
  withProgressLog: vi.fn(async <T>(work: (log: SupervisorModule.ProgressLog) => Promise<T>) => ({
    value: await work({ path: PROGRESS_LOG, guard: { watch: () => undefined } }),
    leftover: undefined,
  })),
}));

const { buildCheckOutputData, runProjectChecks, runResourcesCheckPhase } = await import('../../src/commands/resources/check.js');
const { CHECK_REPORT_SCHEMA, RESOURCES_CHECK_EXAMINED } = await import('../../src/commands/resources/check-schema.js');
const { runPhase } = await import('../../src/commands/phase-utils.js');

forwarded.report = buildCheckOutputData({
  root: '/corpus',
  durationMs: 200,
  populated: { population: 'store', populationMs: 100, lensMs: 0, lensesEvaluated: [], membersEnumerated: 1 },
  issues: [],
  costs: [],
});

/** The root a `vat validate` run resolved — never touched: the child is not spawned. */
const ROOT = safePath.join('/resolved', 'project-root');

/** The one argv the phase handed the supervisor — its stderr captured, so the run writes nothing to the real one. */
async function phaseArgs(debug: boolean, base?: string): Promise<readonly string[]> {
  const { exited } = await captureProcessExit(async () => {
    await runResourcesCheckPhase({ root: ROOT, debug, verbose: false, base });
  });
  expect(exited).toBeUndefined();
  expect(recorded).toHaveLength(1);
  return recorded[0] ?? [];
}

describe('runResourcesCheckPhase — the child\'s argv', () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it.each([false, true])('is `resources check <root> --format json [--debug] --supervised-by phase:<pid>:<log>` (debug=%s)', async (debug) => {
    const args = await phaseArgs(debug);

    expect(args).toStrictEqual([
      'resources',
      'check',
      ROOT,
      '--format',
      'json',
      ...(debug ? ['--debug'] : []),
      '--supervised-by',
      `phase:${String(process.pid)}:${PROGRESS_LOG}`,
    ]);
  });

  it('forwards `--base <ref>`, so a check over changed_files compares with the base vat validate was given', async () => {
    const args = await phaseArgs(false, 'origin/main');

    expect(args).toStrictEqual([
      'resources',
      'check',
      ROOT,
      '--format',
      'json',
      '--base',
      'origin/main',
      '--supervised-by',
      `phase:${String(process.pid)}:${PROGRESS_LOG}`,
    ]);
  });

  it('never narrows the run to one check, and never passes a flag the child does not take', async () => {
    const args = await phaseArgs(true);

    expect(args).not.toContain('--check');
    expect(args).not.toContain('--verbose');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--budget');
    expect(args).not.toContain('--base');
  });
});

const WARNED = {
  code: 'CUSTOM:warn-a', severity: 'warning' as const, message: 'a.md is flagged', location: 'docs/a.md',
};

/** What the phase printed on stderr for a forwarded report carrying one warning, at `verbose`. */
async function stderrAt(verbose: boolean): Promise<string> {
  const previous = forwarded.report;
  forwarded.report = buildCheckOutputData({
    root: '/corpus',
    durationMs: 200,
    populated: { population: 'store', populationMs: 100, lensMs: 0, lensesEvaluated: [], membersEnumerated: 1 },
    issues: [WARNED],
    costs: [],
  });
  try {
    const { stderr } = await captureProcessExit(async () => {
      await runResourcesCheckPhase({ root: ROOT, debug: false, verbose, base: undefined });
    });
    return stderr;
  } finally {
    forwarded.report = previous;
  }
}

describe('runResourcesCheckPhase — the child\'s findings on this process\'s stderr', () => {
  it('prints a warning finding line under verbose: true, and no collapsed hint', async () => {
    const stderr = await stderrAt(true);

    expect(stderr).toContain('docs/a.md: warning: a.md is flagged [CUSTOM:warn-a]');
    expect(stderr).not.toContain('not shown');
  });

  it('collapses it into the hint under verbose: false', async () => {
    const stderr = await stderrAt(false);

    expect(stderr).not.toContain('[CUSTOM:warn-a]');
    expect(stderr).toContain('1 warning/info finding(s) not shown');
  });
});

/**
 * The phase's verdict on a run whose one check declared `examined` and whose examined statement
 * counted `answer` — through the same `runPhase` `vat validate` uses, with the verb's own
 * schema and run-level declaration.
 *
 * @param check - The check's `examined` half
 * @param answer - The count the examined statement returns
 * @returns The phase's judged report
 */
async function phaseVerdictFor(check: { examined: string; allowEmpty?: true }, answer: number): Promise<Report<unknown>> {
  const { issues, costs } = runProjectChecks({
    columnsOf: NO_COLUMNS,
    builtins: [],
    checks: { owned: { description: 'owned', sql: 'SELECT path FROM a', ...check } },
    only: undefined,
    ask: (sql) => (sql === check.examined ? [{ n: answer }] : []),
    validation: undefined,
    membersEnumerated: 3,
  });
  const previous = forwarded.report;
  forwarded.report = buildCheckOutputData({
    root: '/corpus',
    durationMs: 1,
    populated: { population: 'store', lensPopulation: 'none', populationMs: 1, lensMs: 0, lensesEvaluated: [], membersEnumerated: 3 },
    issues,
    costs,
  });
  try {
    const verdict: { report?: Report<unknown> } = {};
    await captureProcessExit(async () => {
      verdict.report = (await runPhase({
        name: 'checks',
        schema: CHECK_REPORT_SCHEMA,
        examined: RESOURCES_CHECK_EXAMINED,
        run: () => runResourcesCheckPhase({ root: ROOT, debug: false, verbose: false, base: undefined }),
      })).report;
    });
    if (verdict.report === undefined) throw new Error('the phase produced no verdict');
    return verdict.report;
  } finally {
    forwarded.report = previous;
  }
}

/**
 * 🔑 A check's own `examined` as `vat validate`'s `checks` phase carries it. The phase forwards the
 * child's document, and the orchestrator re-parses it against the verb's strict schema and judges
 * it with the verb's run-level declaration — so the per-check refusal and fields must come through
 * that path untouched: a field the schema does not know would throw the phase, and a refusal lost
 * there would fold into a run-level pass.
 */
describe('runResourcesCheckPhase — a check that examined nothing', () => {
  it('keeps the refusal and the examined count through the phase', async () => {
    const verdict = await phaseVerdictFor({ examined: 'SELECT COUNT(*) FROM b' }, 0);

    expect(verdict.status === 'error' ? verdict.error : undefined).toBeUndefined();
    expect(verdict.status).toBe('findings');
    expect(verdict.findings.map((finding) => [finding.code, finding.severity]))
      .toStrictEqual([['RESOURCE_CHECK_EXAMINED_NOTHING', 'error']]);
    expect((verdict.data as { checks: unknown[] }).checks).toStrictEqual([
      expect.objectContaining({ name: 'owned', rows: 0, examined: 0 }),
    ]);
  });

  it('passes the phase when the check declared that zero is legitimate, and says so', async () => {
    const verdict = await phaseVerdictFor({ examined: 'SELECT COUNT(*) FROM b', allowEmpty: true }, 0);

    expect(verdict.status).toBe('ok');
    expect((verdict.data as { checks: unknown[] }).checks).toStrictEqual([
      expect.objectContaining({ name: 'owned', examined: 0, allowEmpty: true }),
    ]);
  });
});
