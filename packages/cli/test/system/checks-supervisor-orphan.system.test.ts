/**
 * 🚨 A supervisor that ends, however it ends, takes its checks child with it.
 *
 * The bound lives in the supervisor's timer, so a child that outlives it has nothing left to stop
 * it. Most cases stall the child for good (`child-only-stall-in-population.mjs`, which writes the
 * child's pid to a file first), end the supervisor one way, and assert the child is gone:
 *
 * - a SIGTERM, SIGHUP, SIGINT or SIGQUIT sent to the supervisor's pid ALONE — `kill <pid>`,
 *   `timeout(1)`, a CI runner stopping or cancelling a step — under a standalone `vat resources
 *   check` and under `vat validate`'s checks phase. The supervisor still dies OF the signal, and
 *   leaves no progress directory behind;
 * - a SIGTERM, SIGINT or SIGHUP sent to the `vat` WRAPPER's pid (`dist/bin/vat.js`, what the
 *   package's `bin` names and so what an operator and a CI runner actually start): the wrapper
 *   forwards it to the CLI, which takes the child down, and the wrapper then dies of it too;
 * - a terminal's Ctrl-C: SIGINT to the wrapper's whole process GROUP. The checks child shares that
 *   group (never a leader: that would put it outside the terminal's job control), so it receives
 *   the SIGINT itself and, installing no handler, dies of it; the supervisor's guard kills it too;
 * - a throw in the supervisor's watchdog poll (`parent-only-stat-throws.mjs`). The poll runs in a
 *   timer, outside every caller's `try`, so the supervisor catches it there: the child is killed
 *   and the run is PUBLISHED as one that did not finish — `vat validate`'s RUN_INCOMPLETE with the
 *   finished `resources` phase still in `data.phases`, `vat resources check`'s refusal;
 * - an UNCAUGHT throw outside the poll (`parent-only-uncaught-throw.mjs`). The CLI's last-resort
 *   handler ends the supervisor with `process.exit`, which no signal handler sees, so the `exit`
 *   guard alone kills the child and removes the progress directory;
 * - a SIGKILL of the supervisor, which runs none of its code (on Windows, `TerminateProcess`). Here
 *   the child stalls ASYNCHRONOUSLY (`child-only-async-stall.mjs`: its population waits on I/O
 *   that never completes) and ends ITSELF: the OS closes the stdin pipe its supervisor held, and
 *   the child reads end-of-file, says so on stderr and exits 2. A child blocked inside one SQLite
 *   statement reads nothing until it returns: `checks-supervisor-orphan-loop.system.test.ts`.
 *
 * 🚨 Every "the child is gone within N ms" here is asserted the moment the SUPERVISOR has exited
 * (`startVat().ended`), never after its stderr drains: the child inherits that stderr, so a drain
 * waited for the child, and the bound could not fail.
 *
 * The process that runs the checks' SQL (the child, or `--budget 0`) and its own signal
 * disposition are `checks-sql-process-signals.system.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs, getWrapperPath, safePath } from './test-common.js';
import { BIN_PATH, preload, TXT_ROWS, writeConfig } from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import { alive, killStillRunning, type LiveVat, pidWrittenTo, startVat, within } from './test-helpers/live-vat.js';

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
 * observed being handled. The throw cases involve no signal and run everywhere.
 */
const NO_HANDLED_SIGNALS = process.platform === 'win32';

/**
 * How long the orphaned child may outlive its supervisor. End-of-file reaches a child whose event
 * loop is free at once; the bound is headroom for a loaded runner. The stalled child never ends on
 * its own, so a child that does not notice cannot meet any bound.
 */
const ORPHAN_BOUND_MS = 5000;

/** How long a child the supervisor's guard SIGKILLs may take to be gone — headroom for a loaded runner. */
const KILL_BOUND_MS = 5000;

let dir: string;
// Both processes of the current case, so a red case cannot leave either running.
let supervisor: LiveVat | undefined;
let child: number | undefined;

/**
 * Start a supervisor whose child writes its pid to a file, and wait for it. By default the child
 * stalls for good once the pid is on disk.
 *
 * @param args - The `vat` command
 * @param options - Preloads in place of the stall (the child's and the supervisor's), extra env, and
 *   the script `node` runs
 * @param options.preloads - Test-only preloads
 * @param options.env - Further environment
 * @param options.entry - The CLI (the default) or the `vat` wrapper
 * @param options.ownGroup - Start the supervisor as a process-group leader (POSIX)
 * @returns The supervisor, and the child's pid
 */
async function superviseChild(
  args: readonly string[],
  options: { preloads?: readonly string[]; env?: NodeJS.ProcessEnv; entry?: string; ownGroup?: boolean } = {},
): Promise<{ running: LiveVat; childPid: number }> {
  const pidFile = safePath.join(scratch(), 'child.pid');
  const running = startVat(dir, args, {
    nodeOptions: options.preloads ?? [preload('child-only-stall-in-population.mjs')],
    env: { ...options.env, TEST_CHILD_PID_FILE: pidFile },
    ...(options.entry === undefined ? {} : { entry: options.entry }),
    ...(options.ownGroup === true ? { ownGroup: true } : {}),
  });
  supervisor = running;
  child = await pidWrittenTo(pidFile);
  return { running, childPid: child };
}

/** The progress directories a supervisor minted in this case's TMPDIR and left behind. */
function progressDirsLeft(): string[] {
  return fs.readdirSync(scratch()).filter((name) => name.startsWith('vat-check-'));
}

/**
 * Send `signal` (by `send`), then assert: the stalled child is gone within the bound, the process
 * started died OF that signal, and no progress directory is left — with the positive controls first.
 */
async function expectSignalTakesChildDown(
  running: LiveVat,
  childPid: number,
  signal: NodeJS.Signals,
  send: () => void,
): Promise<void> {
  expect(alive(childPid)).toBe(true);
  // The positive control: the directory the assertion below says is gone exists now.
  expect(progressDirsLeft()).toHaveLength(1);

  send();

  const ending = await running.ended;
  expect(await within(KILL_BOUND_MS, () => !alive(childPid)), running.stderr()).toBe(true);
  expect({ code: ending.code, signal: ending.signal }, ending.stderr).toStrictEqual({ code: null, signal });
  expect(progressDirsLeft()).toStrictEqual([]);
}

describe('the checks supervisor ends — its child ends with it', () => {
  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-orphan-');
  });

  beforeEach(() => {
    writeConfig(dir, [['quick', TXT_ROWS]]);
  });

  afterEach(() => {
    killStillRunning(supervisor, child);
    supervisor = undefined;
    child = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  describe.each(SURFACES)('%s', (_surface, args) => {
    it.skipIf(NO_HANDLED_SIGNALS).each(['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT'] as const)(
      'a %s to the supervisor\'s pid alone kills the stalled child, and the supervisor dies of it',
      async (signal) => {
        const { running, childPid } = await superviseChild(args);
        await expectSignalTakesChildDown(running, childPid, signal, () => running.process.kill(signal));
      },
    );
  });

  // 🚨 The `vat` an operator starts is the WRAPPER, which used to `spawnSync` the CLI: `kill <pid>`
  // killed the wrapper alone, and the CLI with its checks child ran on, reparented, to the bound.
  // Not on Windows: there the wrapper forwards nothing (the console delivers its events to every
  // process), and an outside kill is TerminateProcess.
  it.skipIf(NO_HANDLED_SIGNALS).each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'a %s to the vat WRAPPER\'s pid reaches the supervisor: the stalled child is killed, and the wrapper dies of it',
    async (signal) => {
      const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
        entry: getWrapperPath(import.meta.url),
        // Resolution pinned to this build's CLI, whatever the case's working directory resolves to.
        env: { VAT_BIN: BIN_PATH },
      });
      await expectSignalTakesChildDown(running, childPid, signal, () => running.process.kill(signal));
    },
  );

  // A terminal's Ctrl-C signals the foreground GROUP, the stalled child included.
  it.skipIf(NO_HANDLED_SIGNALS)('a Ctrl-C to the vat WRAPPER\'s whole process group: the stalled child is killed, and the wrapper dies of SIGINT', async () => {
    const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
      entry: getWrapperPath(import.meta.url),
      env: { VAT_BIN: BIN_PATH },
      ownGroup: true,
    });
    await expectSignalTakesChildDown(running, childPid, 'SIGINT', () => process.kill(-(running.process.pid ?? 0), 'SIGINT'));
  });

  it('vat validate: a throw in the supervisor\'s poll kills the stalled child and publishes RUN_INCOMPLETE, the resources phase kept', async () => {
    const { running, childPid } = await superviseChild(['validate'], {
      preloads: [preload('child-only-stall-in-population.mjs'), preload('parent-only-stat-throws.mjs')],
    });

    const ending = await running.ended;

    expect(ending.code).toBe(2);
    expect(ending.document['error']).toMatchObject({ code: 'RUN_INCOMPLETE' });
    const phases = (ending.document['data'] as { phases: Array<{ name: string; status: string }> }).phases;
    expect(phases.find((phase) => phase.name === 'resources')?.status).toBe('ok');
    expect(phases.find((phase) => phase.name === 'checks')?.status).toBe('error');
    expect(await within(KILL_BOUND_MS, () => !alive(childPid))).toBe(true);
    expect(progressDirsLeft()).toStrictEqual([]);
  });

  it('vat resources check: a throw in the supervisor\'s poll kills the stalled child and publishes its refusal', async () => {
    const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
      preloads: [preload('child-only-stall-in-population.mjs'), preload('parent-only-stat-throws.mjs')],
    });

    const ending = await running.ended;

    expect(ending.code).toBe(2);
    expect(ending.document['status']).toBe('error');
    expect((ending.document['error'] as { message: string }).message).toContain('EACCES');
    expect(await within(KILL_BOUND_MS, () => !alive(childPid))).toBe(true);
    expect(progressDirsLeft()).toStrictEqual([]);
  });

  it('an uncaught throw outside the poll: the exit guard alone kills the stalled child and removes the progress directory', async () => {
    const trigger = safePath.join(scratch(), 'throw-now');
    const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
      preloads: [preload('child-only-stall-in-population.mjs'), preload('parent-only-uncaught-throw.mjs')],
      env: { TEST_PARENT_THROW_FILE: trigger },
    });
    expect(alive(childPid)).toBe(true);
    // The positive control: the directory the assertion below says is gone exists now.
    expect(progressDirsLeft()).toHaveLength(1);

    fs.writeFileSync(trigger, '', 'utf-8');
    const ending = await running.ended;

    expect(await within(KILL_BOUND_MS, () => !alive(childPid)), running.stderr()).toBe(true);
    // The CLI's last-resort ending for an uncaught throw (`installLastResortExit`) — no document.
    expect(ending).toMatchObject({ code: 2, signal: null, document: {} });
    expect(progressDirsLeft()).toStrictEqual([]);
  });

  // Runs everywhere: on Windows the kill is `TerminateProcess`, which runs none of the supervisor's
  // code either — and the stdin pipe it held is closed by the OS all the same.
  it('a SIGKILLed supervisor: its asynchronously stalled child reads end-of-file on stdin and ends itself, unpublished', async () => {
    const trace = safePath.join(scratch(), 'child.trace');
    const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
      preloads: [preload('child-only-async-stall.mjs')],
      env: { TEST_CHILD_TRACE_FILE: trace },
    });
    expect(alive(childPid)).toBe(true);

    running.process.kill('SIGKILL');

    const ending = await running.ended;
    // The bound FIRST, at the supervisor's own exit — before anything waits on the child.
    expect(await within(ORPHAN_BOUND_MS, () => !alive(childPid)), running.stderr()).toBe(true);
    if (process.platform !== 'win32') expect(ending.signal, ending.stderr).toBe('SIGKILL');
    // The child's own ending: its one line, and exit 2.
    expect(await running.drained).toContain(`the process supervising this checks run (pid ${String(running.process.pid)}) is gone`);
    expect(fs.readFileSync(trace, 'utf-8')).toBe('exit:2\n');
    // Nothing ran in the supervisor, so its progress directory is left — and it shows the child
    // stopped where it stalled: booted, never populated.
    const [left] = progressDirsLeft();
    expect(left).toBeDefined();
    const log = fs.readFileSync(safePath.join(scratch(), left ?? '', 'progress.jsonl'), 'utf-8');
    expect(log).toContain('"kind":"started"');
    expect(log).not.toContain('"kind":"population"');
  });
});
