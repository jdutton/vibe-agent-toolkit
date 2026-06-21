import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

import which from 'which';

export interface ClaudeSpawnArgs {
  pluginDirs: string[];
  sandboxDir: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/**
 * Pure assembly of the headless `claude -p` argv (spec §9). The prompt is never
 * inlined as an argv string (Windows cmd-quoting safety) and claude 2.x has no
 * `--prompt-file` flag — the prompt is fed to the child's stdin by
 * {@link spawnHeadlessClaude} instead. `--setting-sources ""` suppresses
 * user/project settings; built-in skills remain (§5).
 */
export function assembleClaudeArgs(opts: ClaudeSpawnArgs): string[] {
  const args: string[] = [
    '-p',
    // claude 2.x rejects `-p --output-format stream-json` unless --verbose is
    // also passed ("--output-format=stream-json requires --verbose"). The
    // streamed JSON is piped to stderr for progress visibility.
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', '',
    '--permission-mode', 'bypassPermissions',
    '--add-dir', opts.sandboxDir,
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
  /**
   * Path to the experimenter-prompt file. Its contents are streamed to the
   * child's stdin (claude 2.x reads the `-p` prompt from stdin; there is no
   * `--prompt-file` flag). Kept off argv so the prompt is never inlined
   * (Windows cmd-quoting safety).
   */
  promptFile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** If set, SIGKILL the child if no stdout/stderr output is received for this many ms. */
  stallMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn the headless `claude`. The prompt file is streamed to the child's stdin
 * so the session reads its prompt and then sees EOF (it cannot block on input,
 * §16). Wall-clock kill on timeout. If `stallMs` is set, a resettable stall
 * watchdog kills the child when no output is received for that duration
 * (stalled: true in result).
 */
export async function spawnHeadlessClaude(opts: SpawnHeadlessOptions): Promise<SpawnResult> {
  const bin = which.sync('claude');
  const args = assembleClaudeArgs(opts);

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

    // Feed the prompt to the child via stdin (claude 2.x has no --prompt-file).
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived prompt path
    const promptStream = createReadStream(opts.promptFile);
    promptStream.on('error', err => {
      clearAllTimers();
      child.kill('SIGKILL');
      reject(err);
    });
    // Swallow EPIPE: if the child exits before consuming all stdin, the write
    // end errors — that is not a harness failure (the close handler reports the
    // child's real exit status).
    child.stdin.on('error', () => { /* ignore EPIPE on early child exit */ });
    promptStream.pipe(child.stdin);
    child.stdout.on('data', (d: Buffer) => { opts.onStdout?.(d.toString()); });
    child.stderr.on('data', (d: Buffer) => { opts.onStderr?.(d.toString()); });
    child.on('error', err => { clearAllTimers(); reject(err); });
    child.on('close', code => { clearAllTimers(); resolve({ status: code ?? -1, timedOut, stalled }); });
  });
}
