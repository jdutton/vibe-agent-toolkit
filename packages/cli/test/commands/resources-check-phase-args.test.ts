/**
 * The arguments `vat validate`'s `checks` phase hands its supervised `vat resources check` child.
 *
 * Observed at the supervisor's door: `superviseCheck` is replaced by a recorder, so the argv the
 * phase composes is read exactly as the spawn would receive it, with no process started. The
 * contract: the operand is the root the orchestrator resolved, `--format json` (the phase reads
 * the child's document as JSON), `--debug` iff the orchestrator was given it, and `--cost-log` (the
 * recursion guard) — and never `--check` (a phase runs every check) or `--verbose` (not a flag of
 * the child's).
 */

import type { Report } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SupervisorModule from '../../src/commands/resources/check-supervisor.js';

const recorded: Array<readonly string[]> = [];

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
const ROOT = safePath.join(normalizedTmpdir(), 'resolved-project-root');

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

  it.each([false, true])('is `resources check <root> --format json [--debug] --cost-log <log>` (debug=%s)', async (debug) => {
    const args = await phaseArgs(debug);
    const costLog = args.at(-1) ?? '';

    expect(args).toStrictEqual([
      'resources',
      'check',
      ROOT,
      '--format',
      'json',
      ...(debug ? ['--debug'] : []),
      '--cost-log',
      costLog,
    ]);
    // A real path the supervisor watches, inside a directory this run minted.
    expect(costLog.endsWith('/progress.jsonl')).toBe(true);
  });

  it('never narrows the run to one check, and never passes a flag the child does not take', async () => {
    const args = await phaseArgs(true);

    expect(args).not.toContain('--check');
    expect(args).not.toContain('--verbose');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--budget');
  });
});
