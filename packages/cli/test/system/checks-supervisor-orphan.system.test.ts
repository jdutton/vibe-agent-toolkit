/**
 * 🚨 A supervisor that ends, however it ends, takes its checks child with it.
 *
 * The bound lives in the supervisor's timer, so a child that outlives it has nothing left to stop
 * it. Each case stalls the child for good (`child-only-stall-in-population.mjs`, which writes the
 * child's pid to a file first), ends the supervisor one way, and asserts the child is gone:
 *
 * - a SIGTERM, SIGHUP or SIGINT sent to the supervisor's pid ALONE — `kill <pid>`, `timeout(1)`, a
 *   CI runner stopping or cancelling a step — under a standalone `vat resources check` and under
 *   `vat validate`'s checks phase. The supervisor still dies OF the signal, and leaves no progress
 *   directory behind;
 * - a throw in the supervisor's watchdog poll (`parent-only-stat-throws.mjs`). The poll runs in a
 *   timer, outside every caller's `try`, so the supervisor catches it there: the child is killed
 *   and the run is PUBLISHED as one that did not finish — `vat validate`'s RUN_INCOMPLETE with the
 *   finished `resources` phase still in `data.phases`, `vat resources check`'s refusal.
 *
 * The process that runs the checks' SQL (the child, or `--budget 0`) and its own signal
 * disposition are `checks-sql-process-signals.system.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import { preload, TXT_ROWS, writeConfig } from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import { alive, type LiveVat, pidWrittenTo, startVat, within } from './test-helpers/live-vat.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-checks-orphan-');

/** The two ways the checks child is supervised: standalone, and as `vat validate`'s phase. */
const SURFACES = [
  ['vat resources check', ['resources', 'check', '--budget', '600']],
  ['vat validate', ['validate']],
] as const;

/**
 * ⚠️ Not on Windows: there `kill(pid, <signal>)` is `TerminateProcess`, which runs no handler in the
 * target, and there is no SIGHUP to send — so a signal sent to the supervisor's pid cannot be
 * observed being handled. The poll-throw case involves no signal and runs everywhere.
 */
const NO_HANDLED_SIGNALS = process.platform === 'win32';

let dir: string;
// Both processes of the current case, so a red case cannot leave either running.
let supervisor: LiveVat | undefined;
let child: number | undefined;

/**
 * Start a supervisor whose child stalls for good, and wait until the child is stalled.
 *
 * @param args - The `vat` command
 * @param preloads - Further test-only preloads, for the supervisor
 * @returns The supervisor, and the stalled child's pid
 */
async function superviseStalledChild(
  args: readonly string[],
  ...preloads: string[]
): Promise<{ running: LiveVat; childPid: number }> {
  const pidFile = safePath.join(scratch(), 'child.pid');
  const running = startVat(dir, args, {
    nodeOptions: [preload('child-only-stall-in-population.mjs'), ...preloads],
    env: { TEST_CHILD_PID_FILE: pidFile },
  });
  supervisor = running;
  // The child is stalled, synchronously and for good, the moment its pid is on disk.
  child = await pidWrittenTo(pidFile);
  return { running, childPid: child };
}

/** The progress directories a supervisor minted in this case's TMPDIR and left behind. */
function progressDirsLeft(): string[] {
  return fs.readdirSync(scratch()).filter((name) => name.startsWith('vat-check-'));
}

describe('the checks supervisor ends — its child ends with it', () => {
  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-orphan-');
    writeConfig(dir, [['quick', TXT_ROWS]]);
  });

  afterEach(() => {
    const pid = supervisor?.process.pid;
    if (pid !== undefined && alive(pid)) supervisor?.process.kill('SIGKILL');
    if (child !== undefined && alive(child)) process.kill(child, 'SIGKILL');
    supervisor = undefined;
    child = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  describe.each(SURFACES)('%s', (_surface, args) => {
    it.skipIf(NO_HANDLED_SIGNALS).each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
      'a %s to the supervisor\'s pid alone kills the stalled child, and the supervisor dies of it',
      async (signal) => {
        const { running, childPid } = await superviseStalledChild(args);
        expect(alive(childPid)).toBe(true);
        // The positive control: the directory the assertion below says is gone exists now.
        expect(progressDirsLeft()).toHaveLength(1);

        running.process.kill(signal);

        expect(await running.ended).toMatchObject({ code: null, signal });
        expect(await within(5000, () => !alive(childPid))).toBe(true);
        expect(progressDirsLeft()).toStrictEqual([]);
      },
    );
  });

  it('vat validate: a throw in the supervisor\'s poll kills the stalled child and publishes RUN_INCOMPLETE, the resources phase kept', async () => {
    const { running, childPid } = await superviseStalledChild(['validate'], preload('parent-only-stat-throws.mjs'));

    const ending = await running.ended;

    expect(ending.code).toBe(2);
    expect(ending.document['error']).toMatchObject({ code: 'RUN_INCOMPLETE' });
    const phases = (ending.document['data'] as { phases: Array<{ name: string; status: string }> }).phases;
    expect(phases.find((phase) => phase.name === 'resources')?.status).toBe('ok');
    expect(phases.find((phase) => phase.name === 'checks')?.status).toBe('error');
    expect(await within(5000, () => !alive(childPid))).toBe(true);
    expect(progressDirsLeft()).toStrictEqual([]);
  });

  it('vat resources check: a throw in the supervisor\'s poll kills the stalled child and publishes its refusal', async () => {
    const { running, childPid } = await superviseStalledChild(['resources', 'check', '--budget', '600'], preload('parent-only-stat-throws.mjs'));

    const ending = await running.ended;

    expect(ending.code).toBe(2);
    expect(ending.document['status']).toBe('error');
    expect((ending.document['error'] as { message: string }).message).toContain('EACCES');
    expect(await within(5000, () => !alive(childPid))).toBe(true);
    expect(progressDirsLeft()).toStrictEqual([]);
  });
});
