/**
 * A command a system test starts through `executeCli` / `executeBunVat` ends when its test ends,
 * and so does every process it started.
 *
 * A test that times out stops awaiting its command but does not stop the command: before this
 * teardown, a stalled `vat` outlived its test, its file and the worker, and held a CPU for as long
 * as it ran. The first case starts a command that never exits and that starts a grandchild of its
 * own, writes both pids and returns while they still run — what a test that timed out leaves
 * behind. The second case asserts both are gone. A timed-out test reaches the same teardown
 * (vitest runs `onTestFinished` hooks after a timeout, as after a pass), so this pair proves it
 * without a test that has to fail.
 */

import { afterAll, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, describe, executeCli, expect, fs, join, writeFileTree } from './test-common.js';
import { alive, within } from './test-helpers/live-vat.js';

/** Starts a grandchild that never exits, writes `<own pid> <grandchild pid>` to argv[2], then never exits. */
const STALLING_COMMAND = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], process.pid + ' ' + grandchild.pid);
setInterval(() => {}, 1000);
`;

/** The pids the first case's command wrote: itself and its grandchild. */
let started: readonly number[] = [];

/** The first case's command, which that case never awaits. */
let running: Promise<unknown> | undefined;

/** The first case's scratch directory. */
let scratch: string | undefined;

describe('a command a system test started ends with its test', () => {
  afterAll(() => {
    // A red run must not leave the stalled pair behind either.
    for (const pid of started) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    if (scratch !== undefined) cleanupTestTempDir(scratch);
  });

  it('starts a command that outlives the case and returns while it runs', async () => {
    const dir = createTestTempDir('spawn-teardown-');
    scratch = dir;
    writeFileTree(dir, { 'stall.cjs': STALLING_COMMAND });
    const pidFile = join(dir, 'pids');
    // Deliberately not awaited here: the case ends with the command still running.
    running = executeCli(join(dir, 'stall.cjs'), [pidFile]);
    const written = await within(20_000, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').includes(' '));
    expect(written, 'the command wrote its pids').toBe(true);
    started = fs.readFileSync(pidFile, 'utf-8').split(' ').map(Number);
    expect(started.every((pid) => alive(pid)), `both run while the case does: ${started.join(', ')}`).toBe(true);
  });

  it('finds the command and its grandchild gone once that case ended', async () => {
    expect(started).toHaveLength(2);
    const gone = await within(10_000, () => started.every((pid) => !alive(pid)));
    expect(gone, `still running: ${started.filter((pid) => alive(pid)).join(', ')}`).toBe(true);
    // Its collector settles once the command is gone, so nothing is left waiting on it either.
    await running;
  });
});
