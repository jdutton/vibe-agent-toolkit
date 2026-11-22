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
 *
 * The teardown signals a command only while it still runs: once it has exited, its pid (on POSIX,
 * its process group id) may already name an unrelated process. The third case runs a command to
 * its exit with `process.kill` stubbed in-process, so no group kill is ever sent; the fourth asserts
 * the teardown attempted none.
 */

import { afterAll, it, type MockInstance, vi } from 'vitest';

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

/** The pid of the third case's command, which exited before its case ended. */
let exitedPid: number | undefined;

/** Every group kill aimed at {@link exitedPid}'s group, recorded instead of sent. */
const groupKillsAfterExit: number[] = [];

describe('a command that exited before its test ended is not signalled again', () => {
  // The teardown runs after the case's body, so the stub stays in place until the next case reads
  // what it recorded. A kill aimed at the exited command's group is recorded and never sent: by
  // then that group id may name an unrelated group. Every other call reaches the real process.kill.
  const realKill = process.kill.bind(process);
  let stub: MockInstance<typeof process.kill> | undefined;

  afterAll(() => {
    stub?.mockRestore();
  });

  it.runIf(process.platform !== 'win32')('runs a command to its exit and ends the case', async () => {
    stub = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (exitedPid !== undefined && pid === -exitedPid) {
        groupKillsAfterExit.push(pid);
        return true;
      }
      return realKill(pid, signal);
    });
    const result = await executeCli('-e', ['']);
    expect(result.status, result.stderr).toBe(0);
    exitedPid = result.pid;
  });

  it.runIf(process.platform !== 'win32')('sent no group kill to the exited command once that case ended', () => {
    stub?.mockRestore();
    expect(exitedPid).toBeGreaterThan(0);
    expect(groupKillsAfterExit, `group kills sent after pid ${String(exitedPid)} exited`).toEqual([]);
  });
});
