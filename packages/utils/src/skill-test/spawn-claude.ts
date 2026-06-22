import { spawn, spawnSync } from 'node:child_process';
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

/**
 * SIGKILL the child AND every process in its group. The child is spawned
 * `detached` (POSIX) so it leads a new process group; killing the negated pid
 * reaps backgrounded grandchildren (e.g. a skill that runs `nohup … &`) and
 * orphaned MCP subprocesses that a direct `child.kill()` would leave running.
 *
 * - Guards an undefined pid (child never spawned — nothing to kill).
 * - Swallows the throw (ESRCH) when the group is already gone.
 * - Windows has no POSIX process groups: fall back to `taskkill /T /F`, which
 *   terminates the whole process tree.
 */
export function killProcessTree(child: { pid?: number | undefined }): void {
  const { pid } = child;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- taskkill is a fixed Windows system command (no PATH-injection surface); it is the only POSIX-process-group-free way to terminate the child's tree.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      // Negated pid → deliver the signal to the whole process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ESRCH (no such process/group): the child and its group are already dead.
  }
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
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: lead a new process group so the kill paths can SIGKILL the whole
      // group (backgrounded grandchildren + MCP subprocesses), not just the
      // direct child. Windows has no process groups (taskkill handles the tree).
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let stalled = false;

    // Feed the prompt to the child via stdin (claude 2.x has no --prompt-file).
    // Opened here (before the timers) so every kill path can destroy it and
    // release the prompt-file FD when the child is SIGKILL'd before stdin is
    // fully consumed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived prompt path
    const promptStream = createReadStream(opts.promptFile);

    const wallTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, opts.timeoutMs);

    // Stall watchdog: reset on every stdout/stderr chunk; fire if silent for stallMs.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts.stallMs !== undefined) {
      const stallMs = opts.stallMs;
      const resetStallTimer = (): void => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          killProcessTree(child);
        }, stallMs);
      };
      resetStallTimer();

      child.stdout.on('data', () => { resetStallTimer(); });
      child.stderr.on('data', () => { resetStallTimer(); });
    }

    const clearAllTimers = (): void => {
      clearTimeout(wallTimer);
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      // Destroy the prompt stream so its file descriptor is released on every
      // terminal path (timeout/stall reach here via 'close'; error paths call
      // it directly). On a clean run the stream has already ended — no-op.
      promptStream.destroy();
    };

    promptStream.on('error', err => {
      clearAllTimers();
      killProcessTree(child);
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
