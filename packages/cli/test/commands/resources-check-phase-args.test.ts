/**
 * The arguments `vat validate`'s `checks` phase hands its supervised `vat resources check` child.
 *
 * Observed at the supervisor's door: `superviseCheck` is replaced by a recorder, so the argv the
 * phase composes is read exactly as the spawn would receive it, with no process started — and
 * `withProgressLog` by one that hands over a path without minting a directory, so this unit test
 * touches no filesystem. The contract: the operand is the root the orchestrator resolved,
 * `--format json` (the phase reads the child's document as JSON), `--debug` iff the orchestrator
 * was given it, `--supervised-by phase:<this pid>:<log>` (the recursion guard; `phase` because the
 * child owes no notice its orchestrator already printed) — and never `--check` (a phase runs every check) or
 * `--verbose` (not a flag of the child's).
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
  withProgressLog: vi.fn(async <T>(work: (logPath: string) => Promise<T>) => ({ value: await work(PROGRESS_LOG), leftover: undefined })),
}));

const { buildCheckOutputData, runResourcesCheckPhase } = await import('../../src/commands/resources/check.js');

forwarded.report = buildCheckOutputData({
  root: '/corpus',
  durationMs: 200,
  populated: { population: 'store', populationMs: 100, lensMs: 0, lensesEvaluated: [], membersEnumerated: 1 },
  issues: [],
  costs: [],
});

/** The root a `vat validate` run resolved — never touched: the child is not spawned. */
const ROOT = safePath.join('/resolved', 'project-root');

/** The one argv the phase handed the supervisor. */
async function phaseArgs(debug: boolean): Promise<readonly string[]> {
  await runResourcesCheckPhase({ root: ROOT, debug });
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

  it('never narrows the run to one check, and never passes a flag the child does not take', async () => {
    const args = await phaseArgs(true);

    expect(args).not.toContain('--check');
    expect(args).not.toContain('--verbose');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--budget');
  });
});
