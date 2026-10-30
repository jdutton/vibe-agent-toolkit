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
 * - an uncaught throw in the supervisor's poll (`parent-only-stat-throws.mjs`), which the CLI's
 *   last-resort handler turns into `process.exit` — an ending no signal handler sees.
 *
 * ⚠️ Not on Windows: there `kill(pid, <signal>)` is `TerminateProcess`, which runs no handler in the
 * target, and there is no SIGHUP to send — so a pid-only signal cannot be observed being handled.
 * The uncaught-throw case does not depend on signals, but its child is found and probed with POSIX
 * `kill(pid, 0)` semantics this suite relies on, so it is skipped with the rest.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import { BIN_PATH, preload, TXT_ROWS, writeConfig } from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-checks-orphan-');

/** Whether a process with this pid still exists (a zombie counts until it is reaped). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. Anything else (EPERM) means it exists but is not ours to signal.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Poll `condition` every 50 ms for up to `ms`; true as soon as it holds. */
async function within(ms: number, condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

/** The two ways the checks child is supervised: standalone, and as `vat validate`'s phase. */
const SURFACES = [
  ['vat resources check', ['resources', 'check', '--budget', '600']],
  ['vat validate', ['validate']],
] as const;

/** A supervisor's ending: its exit code, or the signal it died of. */
interface Ending {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

describe.skipIf(process.platform === 'win32')('the checks supervisor ends — its child ends with it', () => {
  let dir: string;
  // Both processes of the current case, so a red case cannot leave either running.
  let parent: ChildProcess | undefined;
  let child: number | undefined;

  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-orphan-');
    writeConfig(dir, [['quick', TXT_ROWS]]);
  });

  afterEach(() => {
    if (parent?.pid !== undefined && alive(parent.pid)) parent.kill('SIGKILL');
    if (child !== undefined && alive(child)) process.kill(child, 'SIGKILL');
    parent = undefined;
    child = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  /**
   * Start a supervisor whose child stalls for good, and wait until the child is stalled.
   *
   * @param args - The `vat` command
   * @param preloads - Further test-only preloads, for the supervisor
   * @returns The supervisor's ending, once it has one, and the stalled child's pid
   */
  async function superviseStalledChild(
    args: readonly string[],
    ...preloads: string[]
  ): Promise<{ ended: Promise<Ending>; childPid: number }> {
    const pidFile = safePath.join(scratch(), 'child.pid');
    const nodeOptions = [process.env['NODE_OPTIONS'], preload('child-only-stall-in-population.mjs'), ...preloads]
      .filter((part) => part !== undefined && part !== '').join(' ');
    parent = spawn(NODE_EXECUTABLE, [BIN_PATH, ...args], {
      cwd: dir,
      env: { ...process.env, NODE_OPTIONS: nodeOptions, TEST_CHILD_PID_FILE: pidFile },
      stdio: 'ignore',
    });
    const supervisor = parent;
    const ended = new Promise<Ending>((resolve) => supervisor.on('exit', (code, signal) => resolve({ code, signal })));

    // The child is stalled, synchronously and for good, the moment its pid is on disk.
    expect(await within(20_000, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8') !== '')).toBe(true);
    child = Number(fs.readFileSync(pidFile, 'utf-8'));
    return { ended, childPid: child };
  }

  /** The progress directories a supervisor minted in this case's TMPDIR and left behind. */
  function progressDirsLeft(): string[] {
    return fs.readdirSync(scratch()).filter((name) => name.startsWith('vat-check-'));
  }

  describe.each(SURFACES)('%s', (_surface, args) => {
    it.each(['SIGTERM', 'SIGHUP', 'SIGINT'] as const)(
      'a %s to the supervisor\'s pid alone kills the stalled child, and the supervisor dies of it',
      async (signal) => {
        const { ended, childPid } = await superviseStalledChild(args);
        expect(alive(childPid)).toBe(true);

        parent?.kill(signal);

        expect(await ended).toStrictEqual({ code: null, signal });
        expect(await within(5000, () => !alive(childPid))).toBe(true);
        expect(progressDirsLeft()).toStrictEqual([]);
      },
    );

    it('an uncaught throw in the supervisor\'s poll still kills the stalled child', async () => {
      const { ended, childPid } = await superviseStalledChild(args, preload('parent-only-stat-throws.mjs'));

      // The CLI's last-resort handler: `process.exit(2)`, which only an `exit` listener sees.
      expect(await ended).toStrictEqual({ code: 2, signal: null });
      expect(await within(5000, () => !alive(childPid))).toBe(true);
    });
  });
});
