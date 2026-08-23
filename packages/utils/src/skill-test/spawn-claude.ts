import { spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { Readable, type Writable } from 'node:stream';

import { spawnHardened } from '../spawn-hardened.js';

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
 *
 * `--no-session-persistence` is load-bearing for the harness's integrity model,
 * not a tidiness flag. Claude Code otherwise writes every headless session to
 * `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl` — plaintext, mode 0600,
 * retained indefinitely — and `CLAUDE_CONFIG_DIR` and `HOME` are both forwarded
 * to the child (they have to be: that is where auth lives). That file falsifies
 * three of the harness's stated guarantees at once:
 *
 *   - the per-run grading NONCE, which {@link SpawnHeadlessOptions.prompt} keeps
 *     off disk precisely so untrusted skill code cannot read it back and forge a
 *     passing grading.json — the grader's own session file contains it verbatim;
 *   - the eval ANSWER KEY (`expected_output`), which `eval-suite-isolation.ts`
 *     exists solely to keep off the executor's filesystem;
 *   - the `--baseline` control, which could read the treatment arm's entire
 *     session by listing `projects/` for its slug.
 *
 * And it leaks ACROSS runs: a transcript from one run is still readable weeks
 * later by the next run's executor, so no per-run randomness helps.
 *
 * VERIFIED on macOS with claude 2.x, both directions: without the flag one
 * `.jsonl` lands under the config dir per spawn; with it, zero, and the session
 * still authenticates. It is `--print`-only, which is exactly this spawn's shape.
 *
 * 🪤 An ephemeral per-spawn `CLAUDE_CONFIG_DIR` — the obvious alternative — does
 * NOT work: on macOS the subscription credential is a Keychain item whose service
 * name is derived from the config-dir PATH, so a fresh dir reports "Not logged
 * in" even with the real `.claude.json` copied in (verified). Materializing the
 * token into a dir the executor can read would be strictly worse than the leak.
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
    '--no-session-persistence',
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

/**
 * Registry of currently in-flight `claude` child processes, keyed by the
 * `ChildProcess` object itself. A child is registered immediately after
 * spawn and unregistered wherever it settles (normal 'close', child-process
 * 'error', or the prompt-stream error path) — a normal completed run always
 * leaves this Set empty.
 *
 * This exists for the concurrent pipeline's error path (spec §orphan-reap):
 * when one worker in a bounded pool throws, `Promise.all` rejects without
 * cancelling its siblings, and the top-level handler calls `process.exit(1)`
 * — tearing down the in-process wall/stall watchdog timers before they fire.
 * Without this registry, up to `concurrency - 1` in-flight `claude` sessions
 * would be orphaned (detached process groups) and keep billing tokens until
 * they self-terminate. The orchestrator's error handler calls
 * {@link killAllActiveClaudeChildren} before exiting to reap them.
 */
const activeClaudeChildren = new Set<ChildProcess>();

/**
 * SIGKILL every currently in-flight `claude` child (and its process tree, via
 * {@link killProcessTree}) and clear the registry. Idempotent — safe to call
 * when the registry is already empty (e.g. every child has already settled,
 * or this has already been called once on the current error path).
 */
export function killAllActiveClaudeChildren(): void {
  for (const child of activeClaudeChildren) {
    killProcessTree(child);
  }
  activeClaudeChildren.clear();
}

export interface SpawnHeadlessOptions extends ClaudeSpawnArgs {
  /**
   * The executor prompt, held IN MEMORY and streamed to the child's stdin
   * (claude 2.x reads the `-p` prompt from stdin; there is no `--prompt-file`
   * flag). Kept off argv so the prompt is never inlined (Windows cmd-quoting
   * safety) AND, deliberately, off disk: the harness stamps a per-run integrity
   * nonce into this prompt, and writing it to a file inside (or beside) the
   * skill-writable sandbox would let untrusted skill code read the nonce back and
   * forge a passing grading.json. Passing it in memory keeps the nonce out of any
   * file the skill can read.
   */
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** If set, SIGKILL the child if no stdout/stderr output is received for this many ms. */
  stallMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * INTERNAL test seam. When set, this executable is spawned instead of resolving
   * `claude` on PATH — letting tests exercise the wall-timeout / stall watchdog
   * against a tiny fake child without a real `claude` install. Production callers
   * never set this; `claude` is resolved via `which`.
   */
  binPath?: string;
}

/**
 * Spawn the headless `claude`. The in-memory prompt is streamed to the child's
 * stdin so the session reads its prompt and then sees EOF (it cannot block on
 * input, §16). Wall-clock kill on timeout. If `stallMs` is set, a resettable
 * stall watchdog kills the child when no output is received for that duration
 * (stalled: true in result).
 */
export async function spawnHeadlessClaude(opts: SpawnHeadlessOptions): Promise<SpawnResult> {
  // opts.binPath is an internal test seam (see SpawnHeadlessOptions); production
  // callers leave it unset and the bare `claude` name is resolved on PATH by
  // spawnHardened. spawnHardened is REQUIRED here (not a bare spawn): on Windows
  // `claude` resolves to a `claude.cmd` shim, and since CVE-2024-27980 a bare
  // spawn of a `.cmd` throws EINVAL — spawnHardened routes it through the shell.
  const args = assembleClaudeArgs(opts);

  return await new Promise<SpawnResult>((resolve, reject) => {
    // `stdio: ['pipe','pipe','pipe']` guarantees all three streams are non-null;
    // spawnHardened is typed to return the generic (nullable-stream) ChildProcess,
    // so narrow to the piped shape here (mirrors Node's own stdio-tuple overload).
    const child = spawnHardened(opts.binPath ?? 'claude', args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: lead a new process group so the kill paths can SIGKILL the whole
      // group (backgrounded grandchildren + MCP subprocesses), not just the
      // direct child. Windows has no process groups (taskkill handles the tree).
      detached: process.platform !== 'win32',
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    // Register immediately after spawn so the child is reapable by
    // killAllActiveClaudeChildren() for the entire time it can be in flight.
    activeClaudeChildren.add(child);

    // Decode BOTH output streams as UTF-8 at the stream, not per chunk.
    //
    // A pipe hands the reader whatever bytes have arrived (typically capped at
    // 64 KiB) with no regard for character boundaries, so `chunk.toString()` on
    // each Buffer independently mangles any multi-byte character that straddles a
    // boundary into replacement characters on both sides of the split. That
    // corruption lands INSIDE a stream-json line, and it costs the harness
    // evidence two ways: the line can stop parsing, silently deleting the tool
    // call in it (see ParsedTranscript.malformedLineCount), or — worse, because
    // nothing reports it — the line still parses with a mangled VALUE, so a
    // contamination needle no longer matches the path the arm actually reached.
    //
    // `setEncoding` runs the stream's own StringDecoder, which holds a partial
    // sequence back until the rest arrives AND flushes whatever is left at EOF, so
    // a genuinely truncated tail still surfaces (as U+FFFD) rather than vanishing.
    // Set before any listener is attached, so no chunk is ever seen undecoded.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let timedOut = false;
    let stalled = false;

    // Feed the prompt to the child via stdin (claude 2.x has no --prompt-file).
    // Built from the in-memory string (never a file — the prompt carries a secret
    // per-run nonce that must not land on the skill-readable filesystem). Created
    // here (before the timers) so every kill path can destroy it if the child is
    // SIGKILL'd before stdin is fully consumed.
    const promptStream = Readable.from([opts.prompt], { objectMode: false });

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
      // Destroy the prompt stream on every terminal path (timeout/stall reach
      // here via 'close'; error paths call it directly) so an unconsumed in-memory
      // stream is torn down. On a clean run the stream has already ended — no-op.
      promptStream.destroy();
      // This is the single choke point every settle path (close/error) runs
      // through, so unregistering here guarantees a normally-completed run
      // leaves the registry empty — no reference leak.
      activeClaudeChildren.delete(child);
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
    // `d` is already a string: setEncoding('utf8') above put the stream's
    // StringDecoder in front of these listeners. Never call `.toString()` here.
    child.stdout.on('data', (d: string) => { opts.onStdout?.(d); });
    child.stderr.on('data', (d: string) => { opts.onStderr?.(d); });
    // Reap on 'error' too: clearAllTimers() unregisters the child, so if 'error'
    // ever fires while the process is actually alive we would otherwise drop it
    // from the reap set without killing it (the exact orphan this file guards
    // against). killProcessTree no-ops on an undefined pid (never-spawned case).
    child.on('error', err => { clearAllTimers(); killProcessTree(child); reject(err); });
    child.on('close', code => { clearAllTimers(); resolve({ status: code ?? -1, timedOut, stalled }); });
  });
}
