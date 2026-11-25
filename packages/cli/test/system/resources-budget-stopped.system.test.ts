/**
 * A supervised run that is stopped and continued — Ctrl-Z, then `fg` — is not killed for the time
 * it spent stopped, and a stop and continue that arrive back to back never leave it stuck.
 *
 * The supervisor and its child share the terminal's process group (the child is never `detached`),
 * so Ctrl-Z's SIGTSTP stops both by its default action and `fg`'s SIGCONT continues both. The
 * supervisor never intercepts SIGTSTP; it only observes SIGCONT, and a late poll is judged one
 * event-loop turn later, by when a pending SIGCONT has been delivered, so the gap the stop lay in
 * is left out of the silence. Before, the whole stopped interval read as silence, and the first
 * poll after `fg` killed a healthy run as a runaway. `check` and `query` share the one supervisor;
 * this drives `query`, the cheaper of the two.
 *
 * The cases send signals to the group, as a terminal does. The group is a job in this session
 * (`ownGroup: 'job'`), never a new session: a new session's group is orphaned, and the kernel
 * discards SIGTSTP sent to one.
 *
 * The last case pins the event-loop ordering the design rests on, on whatever platform runs it.
 *
 * ⚠️ Not on Windows: there is no stop signal there, and so no stopped time to count.
 */

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { gitExecutable, NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, createTestTempDir, safePath, writeFileTree } from './test-common.js';
import { BIN_PATH, MD_ROWS, preload } from './test-helpers/checks-phase.js';
import { type Ending, killStillRunning, type LiveVat, pidWrittenTo, startVat, within } from './test-helpers/live-vat.js';
import { measureBudget, type MeasuredBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its supervised child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-budget-stopped-');

/** How many budgets the run is held stopped: well past one, so a watchdog counting it must fire. */
const BUDGETS_STOPPED = 2;

/** How long the supervisor's event loop is held blocked while a stop and continue arrive. */
const BLOCK_MS = 800;

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

/**
 * How the run ended, or undefined when it had not ended by `ms`.
 *
 * @param running - The run
 * @param ms - How long to wait
 * @returns Its ending, or undefined
 */
async function endingWithin(running: LiveVat, ms: number): Promise<Ending | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([running.ended, late]);
  } finally {
    clearTimeout(timer);
  }
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
  });

  /**
   * Size this case's bound from one complete in-process run, taken right beside it: spawn,
   * population and one cheap statement. Never once per file: a probe taken while the machine was
   * quiet sized a 3 s bound that a loaded runner then spent on the child's boot alone (killed
   * "before the child process had finished starting"), as `measureBudget` warns.
   *
   * @returns The baseline and the bound
   */
  function measureBesideCase(): MeasuredBudget {
    return measureBudget(() => {
      const startedAt = Date.now();
      spawnSync(NODE_EXECUTABLE, [BIN_PATH, 'resources', 'query', MD_ROWS, '--budget', '0'], { cwd: project });
      return Date.now() - startedAt;
    });
  }

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

  /**
   * Start `query --budget` with its child paused at startup for half a budget, in a job group.
   *
   * @returns The supervisor's pid, once the child has written its own
   */
  async function startPausedQuery(): Promise<number> {
    measured = measureBesideCase();
    const { budgetSeconds } = measured;
    const marker = safePath.join(scratch(), 'paused-child.pid');
    running = startVat(project, ['resources', 'query', MD_ROWS, '--budget', String(budgetSeconds)], {
      nodeOptions: [preload('child-only-pause-at-startup.mjs'), preload('parent-only-block-on-usr2.mjs')],
      // Half a budget: the child is certainly alive when the group is stopped, and done well inside one.
      env: {
        TEST_STARTUP_MARKER: marker,
        TEST_CHILD_PAUSE_MS: String(budgetSeconds * 500),
        TEST_PARENT_BLOCK_MS: String(BLOCK_MS),
      },
      ownGroup: 'job',
    });
    childPid = await pidWrittenTo(marker);
    return running.process.pid ?? Number.NaN;
  }

  it('query --budget is not killed for the time it was stopped, and answers', async () => {
    const supervisorPid = await startPausedQuery();

    process.kill(-supervisorPid, 'SIGTSTP');
    // Positive control: the supervisor and its child are both stopped, as Ctrl-Z leaves them.
    expect(await within(5000, () => isStopped(supervisorPid) && isStopped(childPid ?? Number.NaN))).toBe(true);
    await sleep(measured.budgetSeconds * 1000 * BUDGETS_STOPPED);
    process.kill(-supervisorPid, 'SIGCONT');

    const ending = await (running as LiveVat).ended;
    // The bound this case derived, beside the run's own words: a red here says which side moved.
    expect(ending.code, `${JSON.stringify(measured)} ${ending.stderr}`).toBe(0);
    expect(ending.document['error'], ending.stderr).toBeUndefined();
    expect(JSON.stringify(ending.document)).toContain('a.md');
  });

  it('a SIGTSTP and a SIGCONT sent back to back leave nothing stopped: the run answers', async () => {
    const supervisorPid = await startPausedQuery();

    // Block the supervisor's event loop, then stop and continue the group inside the block: both
    // signals reach Node's C handler before any listener can run, as on a busy loop.
    process.kill(supervisorPid, 'SIGUSR2');
    await sleep(BLOCK_MS / 4);
    process.kill(-supervisorPid, 'SIGTSTP');
    await sleep(20);
    process.kill(-supervisorPid, 'SIGCONT');

    // Well past the run's own length and its budget: a supervisor still stopped never ends.
    const ending = await endingWithin(running as LiveVat, measured.budgetSeconds * 1000 * 4);
    expect(ending, `the supervisor never ended; stopped: ${String(isStopped(supervisorPid))}`).toBeDefined();
    expect(ending?.code, ending?.stderr).toBe(0);
    expect(JSON.stringify(ending?.document)).toContain('a.md');
  });

  it('the ordering the watchdog rests on: a pending SIGCONT is delivered before the late timer\'s setImmediate', async () => {
    const probe = spawn('perl', ['-e', 'setpgrp(0, 0); exec @ARGV or die "exec: $!"', NODE_EXECUTABLE,
      fileURLToPath(new URL('test-helpers/sigcont-ordering-probe.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    probe.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    const exited = new Promise<void>((resolve) => probe.once('exit', () => resolve()));
    try {
      expect(await within(10_000, () => out.startsWith('ready'))).toBe(true);
      const pid = probe.pid ?? Number.NaN;
      process.kill(-pid, 'SIGTSTP');
      expect(await within(5000, () => isStopped(pid))).toBe(true);
      await sleep(500);
      process.kill(-pid, 'SIGCONT');
      await exited;
      const line = out.split('\n')[1] ?? '{}';
      // The measurement itself, in the CI log for each platform: the module header cites it.
      console.info(`SIGCONT ordering, ${process.platform} ${process.version}: ${line}`);
      const measuredOrder = JSON.parse(line) as { inImmediate?: boolean };
      expect(measuredOrder.inImmediate, out).toBe(true);
    } finally {
      if (probe.exitCode === null) probe.kill('SIGKILL');
    }
  });
});
