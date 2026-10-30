/**
 * 🚨 A supervisor that ends, however it ends, takes its checks child with it.
 *
 * The bound lives in the supervisor's timer, so a child that outlives it has nothing left to stop
 * it. Most cases stall the child for good (`child-only-stall-in-population.mjs`, which writes the
 * child's pid to a file first), end the supervisor one way, and assert the child is gone:
 *
 * - a SIGTERM, SIGHUP or SIGINT sent to the supervisor's pid ALONE — `kill <pid>`, `timeout(1)`, a
 *   CI runner stopping or cancelling a step — under a standalone `vat resources check` and under
 *   `vat validate`'s checks phase. The supervisor still dies OF the signal, and leaves no progress
 *   directory behind;
 * - a throw in the supervisor's watchdog poll (`parent-only-stat-throws.mjs`). The poll runs in a
 *   timer, outside every caller's `try`, so the supervisor catches it there: the child is killed
 *   and the run is PUBLISHED as one that did not finish — `vat validate`'s RUN_INCOMPLETE with the
 *   finished `resources` phase still in `data.phases`, `vat resources check`'s refusal;
 * - an UNCAUGHT throw outside the poll (`parent-only-uncaught-throw.mjs`). The CLI's last-resort
 *   handler ends the supervisor with `process.exit`, which no signal handler sees, so the `exit`
 *   guard alone kills the child and removes the progress directory;
 * - a SIGKILL of the supervisor, which runs none of its code. Here the child is slow but healthy
 *   (`child-only-slow-units.mjs`) and ends ITSELF: before every progress entry it checks that its
 *   supervisor is still there. A child blocked inside one SQLite statement reaches no entry, and is
 *   not covered.
 *
 * The process that runs the checks' SQL (the child, or `--budget 0`) and its own signal
 * disposition are `checks-sql-process-signals.system.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
 * observed being handled. The throw cases involve no signal and run everywhere.
 */
const NO_HANDLED_SIGNALS = process.platform === 'win32';

/**
 * ⚠️ Not on Windows: a child there keeps naming the parent that spawned it after that parent is
 * gone, and only the pid itself can say it ended — a pid Windows may hand to an unrelated process —
 * so the child's own check of its supervisor cannot be shown to fire in bounded time.
 */
const NO_REPARENTING = process.platform === 'win32';

/** How many cheap checks the slow child runs: two progress entries each. */
const SLOW_CHECKS = 40;
/** How much longer the slow child takes over each progress entry. */
const UNIT_DELAY_MS = 400;
/**
 * How long the orphaned slow child may outlive its supervisor. Its next progress entry comes after
 * one unit — at most the fixture's population plus one delay — while its remaining work is
 * `2 × SLOW_CHECKS × UNIT_DELAY_MS` (32 s): a child that does not end itself cannot meet this.
 */
const ORPHAN_BOUND_MS = 12_000;

let dir: string;
// Both processes of the current case, so a red case cannot leave either running.
let supervisor: LiveVat | undefined;
let child: number | undefined;

/**
 * Start a supervisor whose child writes its pid to a file, and wait for it. By default the child
 * stalls for good once the pid is on disk.
 *
 * @param args - The `vat` command
 * @param options - Preloads in place of the stall (the child's and the supervisor's), and extra env
 * @param options.preloads - Test-only preloads
 * @param options.env - Further environment
 * @returns The supervisor, and the child's pid
 */
async function superviseChild(
  args: readonly string[],
  options: { preloads?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<{ running: LiveVat; childPid: number }> {
  const pidFile = safePath.join(scratch(), 'child.pid');
  const running = startVat(dir, args, {
    nodeOptions: options.preloads ?? [preload('child-only-stall-in-population.mjs')],
    env: { ...options.env, TEST_CHILD_PID_FILE: pidFile },
  });
  supervisor = running;
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
  });

  beforeEach(() => {
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
        const { running, childPid } = await superviseChild(args);
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
    const { running, childPid } = await superviseChild(['validate'], {
      preloads: [preload('child-only-stall-in-population.mjs'), preload('parent-only-stat-throws.mjs')],
    });

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
    const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
      preloads: [preload('child-only-stall-in-population.mjs'), preload('parent-only-stat-throws.mjs')],
    });

    const ending = await running.ended;

    expect(ending.code).toBe(2);
    expect(ending.document['status']).toBe('error');
    expect((ending.document['error'] as { message: string }).message).toContain('EACCES');
    expect(await within(5000, () => !alive(childPid))).toBe(true);
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

    // The CLI's last-resort ending for an uncaught throw (`installLastResortExit`) — no document.
    expect(ending).toMatchObject({ code: 2, signal: null, document: {} });
    expect(await within(5000, () => !alive(childPid))).toBe(true);
    expect(progressDirsLeft()).toStrictEqual([]);
  });

  it.skipIf(NO_REPARENTING)('a SIGKILLed supervisor: its slow child ends itself at its next unit, its work unfinished', async () => {
    writeConfig(dir, Array.from({ length: SLOW_CHECKS }, (_, index) => [`slow${String(index)}`, TXT_ROWS] as const));
    const { running, childPid } = await superviseChild(['resources', 'check', '--budget', '600'], {
      preloads: [preload('child-only-slow-units.mjs')],
      env: { TEST_UNIT_DELAY_MS: String(UNIT_DELAY_MS) },
    });
    expect(alive(childPid)).toBe(true);

    running.process.kill('SIGKILL');

    expect(await running.ended).toMatchObject({ code: null, signal: 'SIGKILL' });
    expect(await within(ORPHAN_BOUND_MS, () => !alive(childPid))).toBe(true);
    // Nothing ran in the supervisor, so its progress directory is left — and it shows the child
    // stopped short: it never reached the end of its checks.
    const [left] = progressDirsLeft();
    expect(left).toBeDefined();
    const log = fs.readFileSync(safePath.join(scratch(), left ?? '', 'progress.jsonl'), 'utf-8');
    expect(log).toContain('"kind":"started"');
    expect(log).not.toContain('"kind":"checks-complete"');
  });
});
