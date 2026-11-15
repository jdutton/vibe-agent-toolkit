/**
 * 🚨 The process that RUNS the checks' SQL installs no signal handler — so a SIGINT or SIGTERM sent
 * straight to it kills it, even while it is blocked inside synchronous `node:sqlite`.
 *
 * A JS signal handler is scheduled by the event loop, and a statement that never returns holds the
 * event loop: with a handler installed, the process SURVIVES SIGINT and SIGTERM, and the operator's
 * Ctrl-C is gone. The supervising process may install handlers (its loop is free); the child it
 * spawns must not, and neither may `--budget 0`, which runs the SQL in the process the operator
 * started. The handler lives in a module the child imports too, so only a run of the real process
 * can tell the two apart.
 *
 * `vat resources query` is held to the same contract: `--budget 0` runs its statement in the
 * operator's process, and `--budget <seconds>` in a supervised child.
 *
 * Each case runs a check (or a query) that never terminates; `sql-process-pid-at-runaway.mjs` writes the pid of
 * the process executing it the moment the statement starts. The signal goes to THAT pid alone.
 *
 * ⚠️ Not on Windows: `kill(pid, <signal>)` there is `TerminateProcess`, which ends any process
 * whatever handlers it has, so a handler installed in error could not turn a case red.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, safePath } from './test-common.js';
import { preload, RUN_INTEGRITY, RUNAWAY_SQL, writeConfig } from './test-helpers/checks-phase.js';
import { createMarkdownGitFixture } from './test-helpers/index.js';
import { alive, type LiveVat, pidWrittenTo, startVat, within } from './test-helpers/live-vat.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-checks-sql-signals-');

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

describe.skipIf(process.platform === 'win32')('the process running the checks\' SQL dies of a signal sent to it', () => {
  let dir: string;
  let running: LiveVat | undefined;
  let sqlPid: number | undefined;

  beforeAll(() => {
    dir = createMarkdownGitFixture('vat-check-sql-signals-');
    writeConfig(dir, [['runaway', RUNAWAY_SQL]]);
  });

  afterEach(() => {
    const pid = running?.process.pid;
    if (pid !== undefined && alive(pid)) running?.process.kill('SIGKILL');
    if (sqlPid !== undefined && alive(sqlPid)) process.kill(sqlPid, 'SIGKILL');
    running = undefined;
    sqlPid = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(dir);
  });

  /** Start `vat <args>` and wait until the process running the runaway statement is inside it. */
  async function blockedInSql(args: readonly string[]): Promise<{ run: LiveVat; pid: number }> {
    const pidFile = safePath.join(scratch(), 'sql.pid');
    running = startVat(dir, args, {
      nodeOptions: [preload('sql-process-pid-at-runaway.mjs')],
      env: { TEST_SQL_PID_FILE: pidFile },
    });
    sqlPid = await pidWrittenTo(pidFile);
    return { run: running, pid: sqlPid };
  }

  /**
   * Block `vat <args>` inside its runaway statement, send `signal` to the process running it, and
   * wait for that process to die of it.
   *
   * @param args - The verb and its arguments
   * @param signal - What to send
   * @param inProcess - Whether the SQL runs in the process the operator started (`--budget 0`)
   * @returns How the operator's process ended
   */
  async function signalMidStatement(
    args: readonly string[],
    signal: (typeof SIGNALS)[number],
    inProcess: boolean,
  ): Promise<Awaited<LiveVat['ended']>> {
    const { run, pid } = await blockedInSql(args);
    // `--budget 0`: the SQL runs in the process the operator started — there is no child.
    if (inProcess) expect(pid).toBe(run.process.pid);
    else expect(pid).not.toBe(run.process.pid);

    process.kill(pid, signal);

    expect(await within(5000, () => !alive(pid))).toBe(true);
    return run.ended;
  }

  const VERBS = [
    ['check', ['resources', 'check']],
    ['query', ['resources', 'query', RUNAWAY_SQL]],
  ] as const;

  it.each(VERBS.flatMap(([verb, args]) => SIGNALS.map((signal) => [verb, signal, args] as const)))(
    '%s --budget 0: a %s to the process dies of it, mid-statement',
    async (_verb, signal, args) => {
      expect(await signalMidStatement([...args, '--budget', '0'], signal, true)).toMatchObject({ code: null, signal });
    },
  );

  it.each(SIGNALS)('the supervised child: a %s to its pid alone kills it, and the supervisor reports that signal', async (signal) => {
    const ending = await signalMidStatement(['resources', 'check', '--budget', '600'], signal, false);
    // The child died mid-statement, after its population: a broken check, not a pass.
    expect(ending.code).toBe(1);
    const findings = ending.document['findings'] as Array<{ code: string; message: string }>;
    const broken = findings.find((finding) => finding.code === RUN_INTEGRITY);
    expect(broken?.message).toContain(signal);
  });

  it.each(SIGNALS)('query --budget: a %s to the child alone kills it, and the supervisor refuses, naming the signal', async (signal) => {
    const ending = await signalMidStatement(['resources', 'query', RUNAWAY_SQL, '--budget', '600'], signal, false);
    // A query that died mid-statement has no answer: refused, never a partial one.
    expect(ending.code).toBe(2);
    const error = ending.document['error'] as { code: string; message: string } | undefined;
    expect(error?.code).toBe('RUN_INCOMPLETE');
    expect(error?.message).toContain(signal);
    expect(error?.message).toContain('while the statement was running');
  });
});
