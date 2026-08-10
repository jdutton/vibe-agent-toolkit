/**
 * Run one vat command and report what happened, including how long it took.
 *
 * Every facet goes through here, so the three properties below are not local
 * conveniences — a mistake in any of them is a wrong number in every report.
 *
 * **A command that never RAN is not a command that exited 0.** `spawnSync`
 * reports ENOENT, a timeout kill and E2BIG alike as `status: null` plus an
 * `error`; publishing that `status` as an exit code invents a clean exit out of
 * a process that never started. {@link RunResult.exitCode} is `null` in exactly
 * those cases and {@link RunResult.spawnError} says which one it was. (This is
 * the same lesson `packages/cli/src/qa-snapshot/capture.ts` documents, and the
 * reason it is restated rather than referenced: the two modules are read apart.)
 *
 * **Env is merged over `process.env`, never replaced.** See {@link buildEnv}.
 *
 * **The output cap is generous on purpose.** `spawnSync`'s 1 MB default sets
 * `ENOBUFS` and hands back a TRUNCATED stream; `vat audit` alone emits ~1.8 MB
 * of YAML on a large corpus, so the default would silently shorten output that
 * a facet then measures or diffs. {@link MAX_OUTPUT_BYTES} matches capture.ts.
 *
 * ## Why not `safeExecResult` from `@vibe-agent-toolkit/utils`
 *
 * It is the closest fit in the toolkit and it is still wrong for this contract:
 * it returns `status: number`, collapsing `spawnSync`'s `null` to `-1`. For a
 * child killed by a signal without `spawnSync` setting an `error` (an external
 * `SIGKILL`, an OOM kill mid-benchmark) that hands back `-1` with no error
 * beside it — indistinguishable at the call site from a program that genuinely
 * exited `-1`, which is precisely the conflation this module exists to prevent.
 * It also drops `signal` entirely. `spawnHardened` is the other candidate and is
 * async (a live `ChildProcess`), while {@link runCommand} is synchronous by
 * contract.
 *
 * So the spawn is `spawnSync` here — but **command resolution and the shell-mode
 * decision are utils', not ours** ({@link launch}), so the `.cmd`/`.bat`/`.ps1`
 * convention cannot drift from `safeExecSync` and `spawnHardened`.
 */

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  buildWindowsShellLine,
  isPathLike,
  resolveShellCommandToken,
  shouldUseShell,
} from '@vibe-agent-toolkit/utils';
import which from 'which';

import type { ResolvedInstrument, RunOptions, RunResult } from './types.js';

/**
 * Cap on each captured child stream.
 *
 * Matches `packages/cli/src/qa-snapshot/capture.ts`, and for the same reason —
 * see this module's header. 256 MB is not a prediction of how much vat emits; it
 * is a ceiling far enough above the largest observed output (~1.8 MB) that
 * hitting it means something is genuinely pathological.
 */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Run one vat command once and report what happened.
 *
 * @param instrument - Which vat to run; `leadingArgs` precede `args`
 * @param args - The vat subcommand and its arguments
 * @param options - Working directory, extra environment, and an optional timeout
 * @returns Wall time, both streams, and an exit code that is `null` when the
 *   process never ran or was killed
 */
export function runCommand(
  instrument: ResolvedInstrument,
  args: readonly string[],
  options: RunOptions,
): RunResult {
  const argv = [...instrument.leadingArgs, ...args];
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd,
    env: buildEnv(options.env),
    encoding: 'utf8',
    // stdin is closed: a child that blocks on input must fail, never hang until
    // the timeout and be recorded as a slow run.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT_BYTES,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };

  // Monotonic, sub-millisecond, and immune to a clock step mid-run — unlike
  // `Date.now()`, whose 1 ms granularity is a large fraction of a fast command.
  // The bracket starts BEFORE resolution, so a command that never spawns still
  // reports the real time spent finding that out rather than a fabricated 0.
  const startedAt = performance.now();
  const result = launch(instrument.command, argv, spawnOptions);
  const wallMs = performance.now() - startedAt;

  return {
    wallMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...classifyExit(result),
  };
}

/**
 * The child's environment: **`process.env` with `extra` merged OVER it.**
 *
 * This is load-bearing, not hygiene. The I/O facet works by setting
 * `NODE_OPTIONS=--require <preload>`, and vat's own launcher spawns a SECOND
 * node process for the real binary — the preload propagates to that descendant
 * through the inherited environment. A harness that handed `spawnSync` only the
 * caller's `env` would strip everything else (`PATH`, `HOME`, `NODE_OPTIONS`
 * set by the surrounding shell) and the facet would silently measure the
 * launcher alone, reporting a plausible number for the wrong process.
 *
 * @param extra - Caller-supplied variables, which win on a key collision
 * @returns The merged environment to hand the child
 */
function buildEnv(extra: RunOptions['env']): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

/**
 * Resolve the command the way utils does, then spawn it.
 *
 * Both halves are utils' decisions, deliberately:
 *
 * - **Resolution** is `isPathLike(command) ? command : which.sync(command)` —
 *   verbatim from `spawnHardened`. An explicit path is spawned as given, so a
 *   nonexistent one surfaces as `spawnSync`'s own `ENOENT` rather than as a
 *   synchronous `which` throw; a bare name (`npx`, the released-instrument
 *   case) is looked up on PATH. `isPathLike`'s docstring names that first
 *   property as the reason it exists.
 * - **Shell mode** is `shouldUseShell(resolved)` — true only for a resolved
 *   `.cmd`/`.bat`/`.ps1` on Windows, which since the CVE-2024-27980 fix Node
 *   refuses to launch without a shell. On Windows a bare `npx` resolves to
 *   `npx.cmd` and takes that branch; a bare `node` resolves to `node.exe` and
 *   does not. Everything else on every platform gets `shell: false` and a real
 *   argv array — the mode with no metacharacter surface at all.
 *
 * @param command - The executable, as the instrument named it
 * @param args - Full argument vector (leading args already prepended)
 * @param options - Prepared `spawnSync` options
 * @returns The `spawnSync` result, or {@link unspawned} when resolution failed
 */
function launch(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  let resolved: string;
  try {
    resolved = isPathLike(command) ? command : which.sync(command);
  } catch (error) {
    // `which.sync` throws when a bare name is not on PATH. That is a spawn
    // failure like any other, so it rejoins the single classification path
    // below rather than becoming a second way for a run to fail.
    return unspawned(error, `could not resolve command '${command}' on PATH`);
  }

  if (!shouldUseShell(resolved)) {
    return spawnSync(resolved, [...args], { ...options, shell: false });
  }

  // Node's DEP0190 rejects `shell: true` alongside a separate args array, so the
  // command and its arguments become one cmd.exe line, per-arg quoted by utils'
  // `windowsShellQuote`. Token selection is utils' too (a bare name stays bare
  // so cmd.exe re-resolves it through PATHEXT; an explicit path is quoted).
  const shellLine = buildWindowsShellLine(resolveShellCommandToken(command, resolved), [...args]);
  // eslint-disable-next-line sonarjs/os-command -- Windows DEP0190 workaround: the command comes from a resolved instrument, and args are per-arg shell-quoted via windowsShellQuote()
  return spawnSync(shellLine, { ...options, shell: true });
}

/**
 * The result `spawnSync` would have produced had it been reached: no pid, no
 * streams, no status, and the error that stopped us.
 *
 * Every field says "nothing happened" rather than letting `0` or `''` stand in
 * for a value — `status: null` in particular, so {@link classifyExit} reads this
 * exactly as it reads a genuine ENOENT.
 *
 * @param cause - Whatever was thrown during resolution
 * @param context - What was being attempted, prefixed to the message
 * @returns A `spawnSync`-shaped result carrying the failure
 */
function unspawned(cause: unknown, context: string): SpawnSyncReturns<string> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    pid: 0,
    output: [null, '', ''],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: new Error(`${context}: ${message}`),
  };
}

/**
 * Decide what the child's exit means, keeping "never ran" separate from "exited".
 *
 * Three outcomes, in the order they must be tested:
 *
 * 1. `spawnSync` set an `error` — ENOENT, a timeout kill, E2BIG, or a failed
 *    resolution via {@link unspawned}. The process produced no exit code of its
 *    own, so `exitCode` is `null`.
 * 2. No error but `status === null` — the child was killed by a signal nobody
 *    recorded as a spawn failure. `exitCode` stays `null` rather than becoming
 *    `-1`, and `spawnError` names the signal so a `null` is never unexplained.
 * 3. A real `status`, INCLUDING a non-zero one. A vat command that exits 1 ran
 *    perfectly well; calling that a spawn error would hide a genuine finding
 *    behind an infrastructure complaint.
 *
 * @param result - The raw `spawnSync` result
 * @returns The exit code and spawn error to publish
 */
function classifyExit(
  result: SpawnSyncReturns<string>,
): Pick<RunResult, 'exitCode' | 'spawnError'> {
  const killedBy = result.signal === null ? '' : ` (killed by signal ${result.signal})`;

  if (result.error !== undefined) {
    return { exitCode: null, spawnError: `${result.error.message}${killedBy}` };
  }
  if (result.status === null) {
    return {
      exitCode: null,
      spawnError: `process produced no exit code${killedBy === '' ? ' (killed by an unrecorded signal)' : killedBy}`,
    };
  }
  return { exitCode: result.status, spawnError: null };
}
