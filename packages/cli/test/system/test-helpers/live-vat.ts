/**
 * A `vat` process a case can act on WHILE it runs — signal it, find its checks child — where
 * `checks-phase.ts`'s `vat()` only returns once the process has ended.
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { isProcessGoneError } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import yaml from 'yaml';

import { fs } from '../test-common.js';

import { BIN_PATH } from './checks-phase.js';

/**
 * Whether a process with this pid still exists (a zombie counts until it is reaped). Every pid
 * asked about is one of this test's own processes, so a refusal to signal it means it is gone.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isProcessGoneError(error)) return false;
    throw error;
  }
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

/** How a `vat` process ended, and the document it published (empty when it published none). */
export interface Ending {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly document: Record<string, unknown>;
}

/** A running `vat` process. */
export interface LiveVat {
  readonly process: ChildProcess;
  /** Settles when the process has ended and its stdout is drained. */
  readonly ended: Promise<Ending>;
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
 * @returns The running process
 */
export function startVat(
  cwd: string,
  args: readonly string[],
  options: { nodeOptions: readonly string[]; env: NodeJS.ProcessEnv },
): LiveVat {
  const nodeOptions = [process.env['NODE_OPTIONS'], ...options.nodeOptions]
    .filter((part) => part !== undefined && part !== '').join(' ');
  const child = spawn(NODE_EXECUTABLE, [BIN_PATH, ...args], {
    cwd,
    env: { ...process.env, ...options.env, NODE_OPTIONS: nodeOptions },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<Ending>((resolve) => {
    child.on('close', (code, signal) => {
      const document = (yaml.parse(Buffer.concat(chunks).toString('utf-8')) ?? {}) as Record<string, unknown>;
      resolve({ code, signal, document });
    });
  });
  return { process: child, ended };
}
