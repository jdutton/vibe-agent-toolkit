/**
 * 🚨 `vat validate` on a warm store ENDED FROM OUTSIDE, the same build run overlapped and
 * sequential. How each mode is taken: `test-helpers/checks-overlap.ts`. The same endings of a
 * sequential supervisor alone, standalone and under `vat validate`: `checks-supervisor-orphan`.
 *
 * Ended in the MIDDLE of its resources phase: overlapped, the checks child the gate spawned is
 * already running, and the guard installed at its spawn must take it down; sequential, no child
 * exists yet.
 *
 * `parent-only-hold-resources.mjs` holds the resources phase at its stat of {@link HOLD_AT}, on a
 * free event loop, so the ending lands at the same point in both modes and is handled at once. The
 * overlapped child is held too, after writing its marker to `stderr.log` (`child-only-stderr-marker.mjs`
 * with a release file nobody creates), so it is alive when the run is ended and cannot end on its
 * own: once its supervisor is gone, only the guard's kill (or the terminal's SIGINT) ends it within
 * the bound.
 *
 * - **Ctrl-C** (POSIX): SIGINT to `vat`'s whole process group. Both modes die of SIGINT; no checks
 *   banner and no child line reach stderr; the child is gone; the interrupt-to-exit latency
 *   overlapped is at most {@link INTERRUPT_LATENCY_MULTIPLE} times the sequential one measured in
 *   the same case, or this machine's measured budget (`warmBudgetSeconds`, as the killed arms
 *   measure theirs) when that is larger. Not compared byte for byte (the spec's Ctrl-C arm).
 * - **SIGTERM to the supervisor's pid alone** (POSIX): the child, held and in no position to read
 *   end-of-file, is ended by the guard's kill alone.
 * - **An uncaught throw** (everywhere): the CLI's last-resort `process.exit`, which only the `exit`
 *   guard sees. Both modes publish the same bytes and leave no directory.
 *
 * In every arm the guard must close the parent's `stderr.log` fd before it removes the directory:
 * on Windows an open fd refuses the removal. `parent-only-open-fd-refuses-removal.mjs` makes POSIX
 * refuse it too, so a guard that removed first leaves the directory (and a line on stderr) here as
 * well.
 *
 * SIGKILLED, which runs none of the supervisor's code (everywhere): the child, stalled
 * asynchronously (`child-only-async-stall.mjs`), ends on its own. POSIX: it reads end-of-file and
 * writes its one line to ITS stderr, which overlapped is `stderr.log` in the progress directory the
 * supervisor leaves behind, so the line is kept there and never reaches the terminal (an exception
 * to the same-output invariant); sequential, the line reaches stderr. Windows: the job object ends
 * it with its supervisor, and none of its code runs.
 *
 * Leftovers are judged by the child's pid (`alive`, `kill(pid, 0)` failing ESRCH) and the
 * progress directories in the case's scratch TMPDIR, never `pgrep`.
 */

import { isProcessGoneError } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, safePath } from './test-common.js';
import { warmBudgetSeconds } from './test-helpers/checks-overlap-kill.js';
import {
  CHECKS_BANNER,
  CHILD_MARKER,
  createOverlapFixture,
  expectSameOutput,
  type ArmOptions,
  type BothModes,
  type Mode,
  type ModeRun,
  type OverlapFixture,
  RESOURCES_BANNER,
  type RunFiles,
  runBothModes,
} from './test-helpers/checks-overlap.js';
import { alive, childEndedWithin, killStillRunning, type LiveVat, pidWrittenTo, within } from './test-helpers/live-vat.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-checks-overlap-ended-');

/** The member whose stat the resources phase is held at: after the home population settled. */
const HOLD_AT = 'docs/b.md';

/** How long a step of reaching the held point may take: generous, for a loaded runner. */
const REACH_MS = 20_000;

/** How long a child the guard SIGKILLs may take to be gone: headroom for a loaded runner. */
const KILL_BOUND_MS = 5000;

/**
 * How long an orphaned child may outlive its SIGKILLed supervisor. End-of-file reaches a child whose
 * event loop is free at once; the bound is headroom for a loaded runner.
 */
const ORPHAN_BOUND_MS = 5000;

/** When a stalled child kills itself: far past both bounds, so a child nothing ended still fails. */
const STALL_CEILING_MS = 12 * Math.max(ORPHAN_BOUND_MS, KILL_BOUND_MS);

/**
 * How many times the sequential arm's interrupt-to-exit latency the overlapped arm may take.
 *
 * Measured on a developer Mac over 9 runs of this case: sequential 7-19 ms, overlapped 7-12 ms, a
 * worst ratio of 1.5. The overlapped handler does more before it re-raises (SIGKILL the child,
 * close the fd, remove the directory). Both figures are a few milliseconds, so one scheduler
 * hiccup on a loaded runner moves the ratio by more than any multiple: the bound is never below
 * this machine's measured budget (a floor of at least 2 s, measured beside the case as the killed
 * arms measure theirs). A handler that waited on the held child, or one held off for the resources
 * phase's 60 s hold, is far past both. At today's latencies the floor always governs; the multiple
 * binds only if the sequential latency itself grows past a tenth of the floor.
 */
const INTERRUPT_LATENCY_MULTIPLE = 10;

/** POSIX only: a process group is a POSIX notion, and Windows has no signal to send a pid's handler. */
const NO_HANDLED_SIGNALS = process.platform === 'win32';

let fixture: OverlapFixture;
// The current case's processes, so a red case cannot leave either running.
let supervisor: LiveVat | undefined;
let child: number | undefined;

/** The progress directories a supervisor minted in this case's TMPDIR and left behind. */
function progressDirsLeft(): string[] {
  return fs.readdirSync(scratch()).filter((name) => name.startsWith('vat-check-'));
}

/** Everything the overlapped child has written to its `stderr.log` so far. */
function heldChildStderr(): string {
  return progressDirsLeft()
    .map((name) => safePath.join(scratch(), name, 'stderr.log'))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf-8'))
    .join('');
}

/**
 * The arm: the resources phase held at {@link HOLD_AT}, the child held after its marker.
 *
 * @param more - Further preloads and environment
 * @param more.preloads - Further test-only preloads
 * @param more.env - Further environment, given this run's files
 * @param act - What ends the run, once it is held; resolves when the case has seen it end
 * @returns The arm's options
 */
function heldMidResources(
  more: { preloads?: readonly string[]; env?: (files: RunFiles) => NodeJS.ProcessEnv },
  act: (running: LiveVat, files: RunFiles, childPid: number | undefined) => Promise<void>,
): ArmOptions {
  return {
    store: 'warm',
    preloads: ['parent-only-hold-resources.mjs', 'parent-only-open-fd-refuses-removal.mjs', ...(more.preloads ?? [])],
    env: (files) => ({
      VAT_TEST_PARENT_HOLD_STAT: HOLD_AT,
      VAT_TEST_PARENT_HELD_FILE: files.path('held'),
      VAT_TEST_CHILD_RELEASE_FILE: files.path('never-released'),
      ...more.env?.(files),
    }),
    during: async (running, files, mode) => {
      supervisor = running;
      const childPid = await reachHeldPoint(running, files, mode);
      await act(running, files, childPid);
    },
  };
}

/**
 * Wait until the run is held mid-resources: its banner written, the hold begun and, overlapped, the
 * child running with its marker in `stderr.log`.
 *
 * @param running - The run
 * @param files - Its files
 * @param mode - Which mode
 * @returns The overlapped child's pid; `undefined` sequential, where no child exists yet
 */
async function reachHeldPoint(running: LiveVat, files: RunFiles, mode: Mode): Promise<number | undefined> {
  const held = await within(REACH_MS, () => running.stderr().includes(RESOURCES_BANNER) && fs.existsSync(files.path('held')));
  expect(held, `${mode}: held mid-resources\n${running.stderr()}`).toBe(true);
  if (mode === 'sequential') {
    expect(fs.existsSync(files.childPid), 'sequential: no child during the resources phase').toBe(false);
    return undefined;
  }
  child = await pidWrittenTo(files.childPid);
  expect(await within(REACH_MS, () => heldChildStderr().includes(CHILD_MARKER)), 'the child spoke into stderr.log').toBe(true);
  expect(alive(child), 'the overlapped child is running when the run is ended').toBe(true);
  return child;
}

/**
 * End the run with `send`, and see it out: the parent's exit, then (overlapped) the child gone
 * within the bound, its clock started at the parent's exit.
 *
 * @param running - The run
 * @param childPid - The overlapped child, if any
 * @param send - What ends the run
 * @returns The time from `send` to the parent's exit with its stdout closed
 */
async function endAndTime(running: LiveVat, childPid: number | undefined, send: () => void): Promise<number> {
  const sentAt = Date.now();
  send();
  await running.ended;
  const latencyMs = Date.now() - sentAt;
  if (childPid !== undefined) expect(await childEndedWithin(KILL_BOUND_MS, running, childPid), running.stderr()).toBe(true);
  return latencyMs;
}

/** What every mid-resources ending leaves: no checks-phase byte on stderr, no directory. */
function expectNothingOfTheChecksPhase(both: BothModes): void {
  for (const run of [both.overlapped, both.sequential] satisfies ModeRun[]) {
    expect(run.stderr, `${run.mode}: the resources banner`).toContain(RESOURCES_BANNER);
    expect(run.stderr, `${run.mode}: no checks banner`).not.toContain(CHECKS_BANNER);
    expect(run.stderr, `${run.mode}: no child line`).not.toContain(CHILD_MARKER);
  }
  expect(both.overlapped.childStarted, 'overlapped: the child ran').toBe(true);
  expect(both.sequential.childStarted, 'sequential: no child ran').toBe(false);
  expect(progressDirsLeft()).toStrictEqual([]);
}

/** Signal the group `running` leads; a group already gone has nothing left to signal. */
function signalGroup(running: LiveVat, signal: NodeJS.Signals): void {
  try {
    process.kill(-(running.process.pid ?? 0), signal);
  } catch (error) {
    if (!isProcessGoneError(error)) throw error;
  }
}

describe('vat validate — ended from outside, same build, both modes', () => {
  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-checks-overlap-ended-');
  });

  afterEach(() => {
    killStillRunning(supervisor, child);
    supervisor = undefined;
    child = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it.skipIf(NO_HANDLED_SIGNALS)('a Ctrl-C to the whole process group: both die of SIGINT, the child is gone, nothing of the checks phase is shown', async () => {
    const floorMs = warmBudgetSeconds(fixture) * 1000;
    const latencyMs: Partial<Record<Mode, number>> = {};
    const both = await runBothModes(fixture, [], {
      ...heldMidResources({}, async (running, _files, childPid) => {
        const mode: Mode = childPid === undefined ? 'sequential' : 'overlapped';
        latencyMs[mode] = await endAndTime(running, childPid, () => signalGroup(running, 'SIGINT'));
      }),
      ownGroup: 'session',
    });

    for (const run of [both.overlapped, both.sequential]) {
      expect({ code: run.code, signal: run.signal }, `${run.mode}\n${run.stderr}`).toStrictEqual({ code: null, signal: 'SIGINT' });
    }
    expectNothingOfTheChecksPhase(both);
    const { overlapped = Number.NaN, sequential = Number.NaN } = latencyMs;
    const boundMs = Math.max(INTERRUPT_LATENCY_MULTIPLE * sequential, floorMs);
    expect(overlapped, `interrupt-to-exit: overlapped ${String(overlapped)} ms, sequential ${String(sequential)} ms, bound ${String(boundMs)} ms`)
      .toBeLessThanOrEqual(boundMs);
  });

  it.skipIf(NO_HANDLED_SIGNALS)('a SIGTERM to the supervisor\'s pid alone: both die of it, and the guard\'s kill alone ends the held child', async () => {
    const both = await runBothModes(fixture, [], heldMidResources({}, async (running, _files, childPid) => {
      await endAndTime(running, childPid, () => running.process.kill('SIGTERM'));
    }));

    for (const run of [both.overlapped, both.sequential]) {
      expect({ code: run.code, signal: run.signal }, `${run.mode}\n${run.stderr}`).toStrictEqual({ code: null, signal: 'SIGTERM' });
    }
    expectNothingOfTheChecksPhase(both);
  });

  it('an uncaught throw: the exit guard ends the held child and removes the directory; output identical', async () => {
    const both = await runBothModes(fixture, [], heldMidResources(
      { preloads: ['parent-only-uncaught-throw.mjs'], env: (files) => ({ TEST_PARENT_THROW_FILE: files.path('throw-now') }) },
      async (running, files, childPid) => {
        await endAndTime(running, childPid, () => fs.writeFileSync(files.path('throw-now'), '', 'utf-8'));
      },
    ));

    // The CLI's last-resort ending for an uncaught throw (`installLastResortExit`): no document.
    expect(both.overlapped).toMatchObject({ code: 2, signal: null, document: {} });
    expectNothingOfTheChecksPhase(both);
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('a SIGKILLed supervisor: its stalled child ends with it; overlapped, the child\'s line is kept in the stderr.log left behind', async () => {
    const left: Partial<Record<Mode, Leftover>> = {};
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      preloads: ['child-only-async-stall.mjs'],
      env: (files) => ({
        TEST_CHILD_PID_FILE: files.path('stalled.pid'),
        TEST_CHILD_TRACE_FILE: files.path('child.trace'),
        TEST_CHILD_MAX_STALL_MS: String(STALL_CEILING_MS),
      }),
      during: async (running, files, mode) => {
        supervisor = running;
        child = await pidWrittenTo(files.path('stalled.pid'));
        const childPid = child;
        expect(alive(childPid)).toBe(true);

        running.process.kill('SIGKILL');

        await running.ended;
        // The bound FIRST, at the supervisor's own exit, by pid on every platform.
        expect(await within(ORPHAN_BOUND_MS, () => !alive(childPid)), `${mode}\n${running.stderr()}`).toBe(true);
        left[mode] = {
          stderrLog: takeLeftoverStderrLog(),
          stderr: await running.drained,
          trace: readIfPresent(files.path('child.trace')),
          gone: `the process supervising this checks run (pid ${String(running.process.pid)}) is gone`,
        };
      },
    });

    for (const run of [both.overlapped, both.sequential]) {
      expect(run.childStarted, run.mode).toBe(true);
      if (process.platform !== 'win32') expect(run.signal, `${run.mode}\n${run.stderr}`).toBe('SIGKILL');
    }
    const { overlapped, sequential } = left;
    if (overlapped === undefined || sequential === undefined) throw new Error('a mode was never ended');
    if (process.platform === 'win32') {
      // The job object ended the child with its supervisor: none of its code ran.
      expect([overlapped.trace, sequential.trace]).toStrictEqual([undefined, undefined]);
      expect(overlapped.stderrLog ?? '').not.toContain(overlapped.gone);
      expect(sequential.stderr).not.toContain(sequential.gone);
      return;
    }
    // POSIX: the child ended itself on end-of-file, exit 2, its one line where its stderr went.
    expect([overlapped.trace, sequential.trace]).toStrictEqual(['exit:2\n', 'exit:2\n']);
    expect(overlapped.stderrLog, 'overlapped: the line, kept in stderr.log').toContain(overlapped.gone);
    expect(overlapped.stderr, 'overlapped: never on the terminal').not.toContain(overlapped.gone);
    expect(sequential.stderrLog, 'sequential: no stderr.log').toBeUndefined();
    expect(sequential.stderr).toContain(sequential.gone);
  });
});

/** What one mode of the SIGKILL arm left, read once its child was gone. */
interface Leftover {
  /** The left directory's `stderr.log`, when it has one (an overlapped run's). */
  readonly stderrLog: string | undefined;
  /** The supervisor's stderr, every holder of it closed. */
  readonly stderr: string;
  /** The child's trace, when any of its code ran at its exit. */
  readonly trace: string | undefined;
  /** The line the child writes when it reads end-of-file, naming this supervisor. */
  readonly gone: string;
}

/** A file's text, or `undefined` when it does not exist. */
function readIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined;
}

/**
 * The one progress directory a SIGKILLed supervisor left in this case's TMPDIR: its `stderr.log`,
 * if it has one. Removed once read, so the next run starts with none.
 */
function takeLeftoverStderrLog(): string | undefined {
  const dirs = progressDirsLeft();
  expect(dirs, 'one progress directory left behind').toHaveLength(1);
  const dir = safePath.join(scratch(), dirs[0] ?? '');
  const stderrLog = readIfPresent(safePath.join(dir, 'stderr.log'));
  fs.rmSync(dir, { recursive: true, force: true });
  return stderrLog;
}
