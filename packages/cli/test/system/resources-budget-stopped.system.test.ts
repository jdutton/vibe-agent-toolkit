/**
 * A supervised run that is stopped and continued — Ctrl-Z, then `fg` — is not killed for the time
 * it spent stopped.
 *
 * The supervisor and its child share the terminal's process group (the child is never `detached`),
 * so Ctrl-Z stops both and `fg` continues both. The watchdog counts silence only while the supervisor
 * is running to watch it: before, it read the whole stopped interval as silence, and its first poll
 * after `fg` killed a healthy run as a runaway. `check` and `query` share the one supervisor; this
 * drives `query`, the cheaper of the two.
 *
 * The case stops the whole group with SIGSTOP, which is what Ctrl-Z's SIGTSTP does by default. It
 * cannot send SIGTSTP itself: the group it starts leads its own session, which makes it an orphaned
 * process group, and the kernel discards SIGTSTP sent to one.
 *
 * ⚠️ Not on Windows: there is no stop signal there, and so no stopped time to count.
 */

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { gitExecutable, NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, createTestTempDir, safePath, writeFileTree } from './test-common.js';
import { BIN_PATH, MD_ROWS, preload } from './test-helpers/checks-phase.js';
import { killStillRunning, type LiveVat, pidWrittenTo, startVat, within } from './test-helpers/live-vat.js';
import { measureBudget, type MeasuredBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its supervised child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-budget-stopped-');

/** How many budgets the run is held stopped: well past one, so a watchdog counting it must fire. */
const BUDGETS_STOPPED = 2;

/**
 * Whether `ps` reports the process as stopped (state `T`).
 *
 * @param pid - One of this case's own processes
 * @returns True when it is stopped
 */
function isStopped(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' });
  return result.stdout.trim().startsWith('T');
}

describe.skipIf(process.platform === 'win32')('a supervised run stopped and continued past its --budget', () => {
  let project: string;
  let measured: MeasuredBudget;
  let running: LiveVat | undefined;
  let childPid: number | undefined;

  beforeAll(() => {
    project = createTestTempDir('vat-budget-stopped-');
    writeFileTree(project, { 'a.md': '# Alpha\n', 'vibe-agent-toolkit.config.yaml': 'resources: {}\n' });
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: project });
    // One complete in-process run sizes the bound: spawn, population and one cheap statement.
    measured = measureBudget(() => {
      const startedAt = Date.now();
      spawnSync(NODE_EXECUTABLE, [BIN_PATH, 'resources', 'query', MD_ROWS, '--budget', '0'], { cwd: project });
      return Date.now() - startedAt;
    });
  });

  afterEach(() => {
    // A red case must leave nothing stopped or running: continue the group, then kill both.
    const pid = running?.process.pid;
    if (pid !== undefined && running?.process.exitCode === null) process.kill(-pid, 'SIGCONT');
    killStillRunning(running, childPid);
    running = undefined;
    childPid = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(project);
  });

  it('query --budget is not killed for the time it was stopped, and answers', async () => {
    const { budgetSeconds } = measured;
    const marker = safePath.join(scratch(), 'paused-child.pid');
    running = startVat(project, ['resources', 'query', MD_ROWS, '--budget', String(budgetSeconds)], {
      nodeOptions: [preload('child-only-pause-at-startup.mjs')],
      // Half a budget: the child is certainly alive when the group is stopped, and done well inside one.
      env: { TEST_STARTUP_MARKER: marker, TEST_CHILD_PAUSE_MS: String(budgetSeconds * 500) },
      ownGroup: true,
    });
    const supervisorPid = running.process.pid ?? Number.NaN;
    childPid = await pidWrittenTo(marker);

    process.kill(-supervisorPid, 'SIGSTOP');
    // Positive control: the supervisor and its child are both stopped, as Ctrl-Z leaves them.
    expect(await within(5000, () => isStopped(supervisorPid) && isStopped(childPid ?? Number.NaN))).toBe(true);
    await sleep(budgetSeconds * 1000 * BUDGETS_STOPPED);
    process.kill(-supervisorPid, 'SIGCONT');

    const ending = await running.ended;
    expect(ending.code, ending.stderr).toBe(0);
    expect(ending.document['error'], ending.stderr).toBeUndefined();
    expect(JSON.stringify(ending.document)).toContain('a.md');
  });
});
