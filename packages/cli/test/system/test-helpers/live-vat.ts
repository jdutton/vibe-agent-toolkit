/**
 * A `vat` process a case can act on WHILE it runs — signal it, find its checks child — where
 * `checks-phase.ts`'s `vat()` only returns once the process has ended.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { isPathAbsentError, isProcessGoneError } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { expect } from 'vitest';
import yaml from 'yaml';

import { fs } from '../test-common.js';

import { BIN_PATH } from './checks-phase.js';

/**
 * Whether a process with this pid is still running. Every pid asked about is one of this test's own
 * processes, so a refusal to signal it means it is gone.
 *
 * 🪤 A ZOMBIE is dead. A process that has exited but whose parent died first is reaped by whatever
 * adopted it, and until then `kill(pid, 0)` still succeeds — so a case run where the adopter does
 * not reap (a container whose PID 1 is not an init) would wait out its whole bound on a process
 * that finished at once. Where `/proc` exists (Linux, where such containers run) the state is read
 * there, and `Z` reads as gone. Elsewhere — macOS, whose launchd reaps at once, and Windows, which
 * has no zombies — `kill(pid, 0)` is the answer, and the cases rely on a reaping PID 1.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isProcessGoneError(error)) return false;
    throw error;
  }
  return !isZombie(pid);
}

/**
 * Whether `/proc` says this pid is a zombie; false where there is no `/proc` entry to read.
 *
 * @param pid - A process `kill(pid, 0)` still reaches
 * @returns True for state `Z`
 */
function isZombie(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf-8');
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw error;
  }
  // `<pid> (<comm>) <state> …` — the command may hold spaces and parentheses, so read past the LAST `)`.
  return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
}

/** Poll `condition` every 50 ms for up to `ms`; resolves true as soon as it holds. */
export function within(ms: number, condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const look = (): void => {
      if (condition()) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(look, 50);
    };
    look();
  });
}

/** Wait (up to 20 s) for `file` to hold a pid, and return it. */
export async function pidWrittenTo(file: string): Promise<number> {
  const written = await within(20_000, () => fs.existsSync(file) && fs.readFileSync(file, 'utf-8') !== '');
  if (!written) throw new Error(`no pid was written to ${file} within 20 s`);
  return Number(fs.readFileSync(file, 'utf-8'));
}

/**
 * SIGKILL a case's supervisor and its checks child, whichever is still running — so a red case
 * cannot leave either behind.
 *
 * @param supervisor - The supervising `vat`, when the case started one
 * @param child - The checks child's pid, when the case read one
 */
export function killStillRunning(supervisor: LiveVat | undefined, child: number | undefined): void {
  const pid = supervisor?.process.pid;
  if (pid !== undefined) killIfRunning(pid);
  if (child !== undefined) killIfRunning(child);
}

/**
 * SIGKILL `pid` unless it is already gone. The `alive` check alone races: a process that ends
 * between it and the signal makes `kill` throw ESRCH, which a teardown must read as "gone".
 *
 * @param pid - One of this test's own processes
 */
function killIfRunning(pid: number): void {
  if (!alive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isProcessGoneError(error)) throw error;
  }
}

/**
 * Assert how a checks child ended once its supervisor was SIGKILLed — call it once the child is gone.
 * `trace` is the file the child's preload appends `published` (on its first stdout write) and
 * `exit:<code>` (in its `exit` handler) to.
 *
 * - **POSIX**: nothing kills the child, so it ends ITSELF on reading end-of-file on the stdin pipe
 *   its supervisor held — its one stderr line, exit 2, and no `published` before it.
 * - **Windows**: libuv puts every child it spawns without `detached` in a job object with
 *   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`uv__init_global_job_handle`, `src/win/process.c`). The
 *   supervisor holds the job's only handle, so its `TerminateProcess` closes the job and the OS
 *   terminates the child with it: no handler runs, so there is no trace at all and no line. A child
 *   that had published, or that ended itself, leaves a trace — which fails the case.
 *
 * @param running - The SIGKILLed supervisor
 * @param trace - The child's trace file
 */
export async function expectOrphanedChildEnding(running: LiveVat, trace: string): Promise<void> {
  const stderr = await running.drained;
  const line = `the process supervising this checks run (pid ${String(running.process.pid)}) is gone`;
  const traced = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf-8') : undefined;
  if (process.platform === 'win32') {
    expect(traced, stderr).toBeUndefined();
    expect(stderr).not.toContain(line);
    return;
  }
  expect(stderr, `TRACE=${String(traced)}`).toContain(line);
  expect(traced).toBe('exit:2\n');
}

/**
 * How a `vat` process ended, the document it published (empty when it published none), and its
 * stderr SO FAR — a child it left running may still write more (see {@link LiveVat.drained}).
 */
export interface Ending {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly document: Record<string, unknown>;
  readonly stderr: string;
}

/** A running `vat` process. */
export interface LiveVat {
  readonly process: ChildProcess;
  /**
   * Settles when the process has EXITED and its stdout has closed.
   *
   * 🚨 Not on `close`. `close` also waits for stderr, and a checks child INHERITS this process's
   * stderr — so `close` waited for the child too, and a case's "the child is gone within N ms",
   * asserted after it, could never fail: a child that never ended showed up as the case's own
   * timeout instead. Stdout is the supervisor's alone (the child's goes to the supervisor).
   */
  readonly ended: Promise<Ending>;
  /** Settles with ALL of stderr once every holder of it — a child it outlived included — has closed it. */
  readonly drained: Promise<string>;
  /** Everything it has written to stderr so far — for an assertion's message while it still runs. */
  stderr(): string;
}

/**
 * Start `vat <args>` in `cwd`, with `nodeOptions` (preloads) APPENDED to the ambient
 * `NODE_OPTIONS` and `env` added to the environment.
 *
 * @param cwd - The working directory
 * @param args - The `vat` command
 * @param options - The preloads and the extra environment
 * @param options.nodeOptions - Test-only preloads
 * @param options.env - Extra environment variables
 * @param options.entry - The script `node` runs: the CLI (`dist/bin.js`, the default) or the `vat`
 *   wrapper the package's `bin` names (`dist/bin/vat.js`)
 * @param options.ownGroup - POSIX: start it as a process-group leader, so a case can signal the
 *   whole GROUP (`process.kill(-pid, …)`) the way a terminal's Ctrl-C does
 * @returns The running process
 */
export function startVat(
  cwd: string,
  args: readonly string[],
  options: { nodeOptions: readonly string[]; env: NodeJS.ProcessEnv; entry?: string; ownGroup?: boolean },
): LiveVat {
  const nodeOptions = [process.env['NODE_OPTIONS'], ...options.nodeOptions]
    .filter((part) => part !== undefined && part !== '').join(' ');
  const child = spawn(NODE_EXECUTABLE, [options.entry ?? BIN_PATH, ...args], {
    cwd,
    env: { ...process.env, ...options.env, NODE_OPTIONS: nodeOptions },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: options.ownGroup === true,
  });
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
  const stderr = (): string => Buffer.concat(errChunks).toString('utf-8');
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const stdoutClosed = new Promise<void>((resolve) => {
    child.stdout?.once('close', () => resolve());
  });
  const ended = Promise.all([exited, stdoutClosed]).then(([{ code, signal }]) => {
    const document = (yaml.parse(Buffer.concat(chunks).toString('utf-8')) ?? {}) as Record<string, unknown>;
    return { code, signal, document, stderr: stderr() };
  });
  const drained = new Promise<string>((resolve) => {
    child.once('close', () => resolve(stderr()));
  });
  return { process: child, ended, drained, stderr };
}
