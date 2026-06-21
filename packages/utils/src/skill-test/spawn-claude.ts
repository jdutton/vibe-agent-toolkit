import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

import which from 'which';

export interface ClaudeSpawnArgs {
  promptFile: string;
  pluginDirs: string[];
  sandboxDir: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/**
 * Pure assembly of the headless `claude -p` argv (spec §9). The prompt is read
 * from a file via the prompt-file flag — never inlined as an argv string
 * (Windows cmd-quoting safety). `--setting-sources ""` suppresses user/project
 * settings; built-in skills remain (§5).
 */
export function assembleClaudeArgs(opts: ClaudeSpawnArgs): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--setting-sources', '',
    '--permission-mode', 'bypassPermissions',
    '--add-dir', opts.sandboxDir,
    '--prompt-file', opts.promptFile,
  ];
  for (const dir of opts.pluginDirs) {
    args.push('--plugin-dir', dir);
  }
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.maxTurns !== undefined) args.push('--max-turns', String(opts.maxTurns));
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  return args;
}

export interface SpawnResult {
  status: number;
  timedOut: boolean;
  stalled: boolean;
}

export interface SpawnHeadlessOptions extends ClaudeSpawnArgs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** If set, SIGKILL the child if no stdout/stderr output is received for this many ms. */
  stallMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn the headless `claude`. stdin is redirected from the OS null device so
 * the session cannot block on input (§16). Wall-clock kill on timeout.
 * If `stallMs` is set, a resettable stall watchdog kills the child when no
 * output is received for that duration (stalled: true in result).
 */
export async function spawnHeadlessClaude(opts: SpawnHeadlessOptions): Promise<SpawnResult> {
  const bin = which.sync('claude');
  const args = assembleClaudeArgs(opts);
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    let stalled = false;

    const wallTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    // Stall watchdog: reset on every stdout/stderr chunk; fire if silent for stallMs.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts.stallMs !== undefined) {
      const stallMs = opts.stallMs;
      const resetStallTimer = (): void => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          child.kill('SIGKILL');
        }, stallMs);
      };
      resetStallTimer();

      child.stdout.on('data', () => { resetStallTimer(); });
      child.stderr.on('data', () => { resetStallTimer(); });
    }

    const clearAllTimers = (): void => {
      clearTimeout(wallTimer);
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    };

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    createReadStream(nullDevice).pipe(child.stdin);
    child.stdout.on('data', (d: Buffer) => { opts.onStdout?.(d.toString()); });
    child.stderr.on('data', (d: Buffer) => { opts.onStderr?.(d.toString()); });
    child.on('error', err => { clearAllTimers(); reject(err); });
    child.on('close', code => { clearAllTimers(); resolve({ status: code ?? -1, timedOut, stalled }); });
  });
}
