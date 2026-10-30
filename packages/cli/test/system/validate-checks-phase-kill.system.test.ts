/**
 * The checks child, KILLED: by the watchdog while a check runs or during the population (the
 * kill rows of `vat validate`'s exit table), and with its supervisor terminated from outside.
 *
 * 🪤 The phase runs its child under the DEFAULT bound and `vat validate` accepts no flag to change
 * it, so a watchdog kill case would wait five minutes. `parent-only-fast-clock.mjs` scales the
 * supervising process's clock from the spawn on, so the default bound elapses in the real seconds
 * `measureBudget()` derives for this machine, exactly as a standalone kill case derives `--budget`.
 */

import { spawn } from 'node:child_process';

import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_BUDGET_SECONDS } from '../../src/commands/resources/check-supervisor.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import {
  BIN_PATH,
  checksPhase,
  preload,
  RUN_INTEGRITY,
  RUNAWAY_SQL,
  TXT_ROWS,
  vat,
  writeConfig,
} from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import { measureBudget } from './test-helpers/measure-check-budget.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-validate-checks-kill-');

let projectDir: string;

/**
 * The environment that makes the phase's default bound elapse in this machine's measured budget:
 * `NODE_OPTIONS` loading the fast clock (plus `more`), and the scale that maps the default bound
 * onto the measured one. Measured beside each killed case, never once per file.
 */
function boundedPhase(...more: string[]): NodeJS.ProcessEnv {
  const { budgetSeconds } = measureBudget(() => {
    writeConfig(projectDir, [['quick', TXT_ROWS]]);
    return vat(projectDir, ['resources', 'check', '--budget', '0']).elapsedMs;
  });
  return {
    NODE_OPTIONS: [preload('parent-only-fast-clock.mjs'), ...more].join(' '),
    TEST_PARENT_CLOCK_SCALE: String(DEFAULT_BUDGET_SECONDS / budgetSeconds),
  };
}

describe('vat validate — the checks phase, killed by its bound', () => {
  beforeAll(() => {
    projectDir = createMarkdownGitFixture('vat-validate-checks-kill-');
  });

  afterAll(() => {
    cleanupTestTempDir(projectDir);
  });

  it('kills a check that never finishes: RESOURCE_CHECK_BROKEN naming it, the statement remedy, exit 1', () => {
    const env = boundedPhase();
    writeConfig(projectDir, [['runaway', RUNAWAY_SQL]]);

    const run = vat(projectDir, ['validate'], env);

    expect(run.status).toBe(1);
    const broken = run.findings.find((f) => f.code === RUN_INTEGRITY && f.message.includes('runaway'));
    // The statement branch's own sentence — not the population's, startup's or reporting's.
    expect(broken?.message).toContain('A statement that will not finish');
    expect(broken?.message).toContain('`vat resources check --budget <seconds>`');
    expect(broken?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });

  it('a child killed during population is a phase error: RUN_INCOMPLETE, the population remedy, exit 2', () => {
    const env = boundedPhase(preload('child-only-stall-in-population.mjs'));
    writeConfig(projectDir, [['quick', TXT_ROWS]]);

    const run = vat(projectDir, ['validate'], env);

    expect(run.status).toBe(2);
    expect(run.error?.code).toBe('RUN_INCOMPLETE');
    const phase = checksPhase(run);
    expect(phase.status).toBe('error');
    expect(phase.error?.message).toContain('Population is legitimately slow');
    expect(phase.error?.message).toContain('`vat resources check --budget <seconds>`');
    expect(phase.error?.message).not.toMatch(/(?<!vat resources check )`--budget/);
  });
});

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

/**
 * 🚨 A supervisor terminated by a signal sent to ITS pid alone — `kill <pid>`, `timeout(1)`, a CI
 * runner stopping a step — must take its child with it. The bound lives in the supervisor's timer,
 * so an orphaned child has nothing left to stop it.
 *
 * ⚠️ Not on Windows: there `kill(pid, 'SIGTERM')` is `TerminateProcess`, which runs no handler in the
 * target, so no supervisor-side mechanism can exist to observe — and Windows has no SIGHUP to send.
 */
describe.skipIf(process.platform === 'win32')('vat resources check — its supervisor terminated from outside', () => {
  let dir: string;
  let orphan: number | undefined;

  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-orphan-');
    writeConfig(dir, [['quick', TXT_ROWS]]);
  });

  afterEach(() => {
    // A red run leaves the stalled child behind; never let it outlive the case.
    if (orphan !== undefined && alive(orphan)) process.kill(orphan, 'SIGKILL');
    orphan = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)('a %s to the supervisor\'s pid kills the stalled child, and the supervisor dies of it', async (signal) => {
    const pidFile = safePath.join(scratch(), 'child.pid');
    const nodeOptions = [process.env['NODE_OPTIONS'], preload('child-only-stall-in-population.mjs')]
      .filter((part) => part !== undefined && part !== '').join(' ');
    const parent = spawn(NODE_EXECUTABLE, [BIN_PATH, 'resources', 'check', '--budget', '600'], {
      cwd: dir,
      env: { ...process.env, NODE_OPTIONS: nodeOptions, TEST_CHILD_PID_FILE: pidFile },
      stdio: 'ignore',
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => parent.on('exit', (_code, sig) => resolve(sig)));

    // The child is stalled, synchronously and for good, the moment its pid is on disk.
    expect(await within(20_000, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8') !== '')).toBe(true);
    const child = Number(fs.readFileSync(pidFile, 'utf-8'));
    orphan = child;
    expect(alive(child)).toBe(true);

    parent.kill(signal);

    expect(await exited).toBe(signal);
    expect(await within(5000, () => !alive(child))).toBe(true);
  });
});
