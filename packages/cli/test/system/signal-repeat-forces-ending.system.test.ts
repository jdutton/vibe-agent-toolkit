/**
 * 🚨 A second terminating signal, sent once the first has had its moment, ENDS the process — a
 * cleanup that hung cannot keep it alive — and a cleanup that holds nothing open cannot let it
 * end in exit 0.
 *
 * `handleTerminatingSignals` swallows a repeat that arrives with the first signal (a terminal's
 * group Ctrl-C reaches the `vat` wrapper and the CLI both, and the wrapper forwards). It used to
 * swallow EVERY repeat while a cleanup ran: an operator whose Ctrl-C met a cleanup that hung could
 * no longer end the run, and the wrapper ignored every further signal while the CLI lived. And a
 * cleanup whose promise held nothing open let the event loop empty: Node exited 0 — a success
 * status — instead of dying of the signal.
 *
 * Both through real processes, with a stand-in CLI built on the shipped helper (`dist`). POSIX
 * only: on Windows an outside kill is `TerminateProcess`, which runs no handler.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { fs, getWrapperPath, safePath } from './test-common.js';
import { alive, pidWrittenTo, within } from './test-helpers/live-vat.js';

const scratch = useScratchTmpdir('vat-scratch-signal-repeat-');

/** The shipped helper the stand-ins guard themselves with. */
const UTILS_PROCESS_URL = new URL('../../../utils/dist/process.js', import.meta.url).href;

/** Past the swallow window (`REPEAT_SIGNAL_WINDOW_MS`, 500 ms) with headroom for a loaded runner. */
const AFTER_WINDOW_MS = 900;

/** How long a forced ending may take to show — headroom for a loaded runner; the cleanup takes 20 s. */
const END_BOUND_MS = 5000;

/**
 * A stand-in process guarded by the shipped helper: its cleanup never settles in `hang` mode (and
 * nothing else holds it open), or takes 20 s holding a timer in `slow` mode. It writes its pid to
 * `TEST_PID_FILE` once guarded, and stays alive until signalled.
 */
function writeStandIn(mode: 'hang' | 'slow'): string {
  const cleanup = mode === 'hang' ? '() => new Promise(() => {})' : '() => new Promise((resolve) => setTimeout(resolve, 20_000))';
  const path = safePath.join(scratch(), `stand-in-${mode}.mjs`);
  fs.writeFileSync(path, [
    "import fs from 'node:fs';",
    `const { handleTerminatingSignals } = await import(${JSON.stringify(UTILS_PROCESS_URL)});`,
    `handleTerminatingSignals({ fallbackExitCode: 2, cleanup: ${cleanup} });`,
    "fs.writeFileSync(process.env.TEST_PID_FILE, String(process.pid), 'utf-8');",
    // Alive until signalled; the first signal lets go of it — and of this listener, so the re-raise
    // still meets the default disposition.
    'const alive = setInterval(() => {}, 1000);',
    "const letGo = () => { clearInterval(alive); for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(s, letGo); };",
    "for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.prependListener(s, letGo);",
  ].join('\n'), 'utf-8');
  return path;
}

/** Spawn `args` under node, and how it exits. */
function start(args: string[], env: NodeJS.ProcessEnv): { process: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(NODE_EXECUTABLE, args, { cwd: scratch(), env: { ...process.env, ...env }, stdio: 'ignore' });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { process: child, exited };
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  clearTimeout(timer);
  return settled;
}

const leftRunning: number[] = [];

describe.skipIf(process.platform === 'win32')('a repeated terminating signal', () => {
  afterEach(() => {
    for (const pid of leftRunning.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });

  it('a cleanup that holds nothing open: the process does not end in exit 0, and a repeat after the window ends it of the signal', async () => {
    const pidFile = safePath.join(scratch(), 'hang.pid');
    const running = start([writeStandIn('hang')], { TEST_PID_FILE: pidFile });
    const pid = await pidWrittenTo(pidFile);
    leftRunning.push(pid);

    process.kill(pid, 'SIGTERM');
    // Without the hold, the loop emptied here and Node exited 0.
    expect(await settlesWithin(running.exited, AFTER_WINDOW_MS)).toBe(false);

    process.kill(pid, 'SIGTERM');
    expect(await settlesWithin(running.exited, END_BOUND_MS)).toBe(true);
    expect(await running.exited).toStrictEqual({ code: null, signal: 'SIGTERM' });
  });

  it('the vat wrapper over a CLI whose cleanup hangs: a second SIGTERM after the window ends the wrapper AND the CLI', async () => {
    const pidFile = safePath.join(scratch(), 'cli.pid');
    const wrapper = start([getWrapperPath(import.meta.url)], { VAT_BIN: writeStandIn('slow'), TEST_PID_FILE: pidFile });
    const wrapperPid = wrapper.process.pid ?? 0;
    leftRunning.push(wrapperPid);
    const cliPid = await pidWrittenTo(pidFile);
    leftRunning.push(cliPid);

    process.kill(wrapperPid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, AFTER_WINDOW_MS));
    // The first was forwarded; the CLI is still in its 20 s cleanup, and the wrapper waits on it.
    expect(alive(wrapperPid) && alive(cliPid)).toBe(true);

    process.kill(wrapperPid, 'SIGTERM');
    expect(await settlesWithin(wrapper.exited, END_BOUND_MS)).toBe(true);
    expect(await wrapper.exited).toStrictEqual({ code: null, signal: 'SIGTERM' });
    expect(await within(END_BOUND_MS, () => !alive(cliPid))).toBe(true);
  });
});
