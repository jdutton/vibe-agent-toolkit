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
 * **Env is merged over `process.env`, never replaced — except the arm-owned
 * keys.** `process.env` is inherited so the io facet's `NODE_OPTIONS` preload
 * reaches vat's second node process; the variables that decide WHICH vat runs
 * (`VAT_BIN`, `VAT_ROOT_DIR`, …) are never inherited, only set by the arm. See
 * {@link buildEnv} and `arm-env.ts`.
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
import { accessSync, constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';

import { followedStatSync, fsFaultOf, safePath } from '@vibe-agent-toolkit/utils';
import {
  buildWindowsShellLine,
  isPathLike,
  resolveShellCommandToken,
  shouldUseShell,
} from '@vibe-agent-toolkit/utils/process';

import { buildArmEnv, envNameSpelling } from './arm-env.js';
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
 * Any command, not only vat: a sequence's non-VAT step (`pnpm install`) is a
 * command with no leading arguments.
 *
 * @param instrument - What to run; `leadingArgs` precede `args`
 * @param args - The subcommand and its arguments
 * @param options - Working directory, the arm's environment, and an optional timeout
 * @returns Wall time, both streams, and an exit code that is `null` when the
 *   process never ran or was killed
 */
export function runCommand(
  instrument: Pick<ResolvedInstrument, 'command' | 'leadingArgs'>,
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
  const result = launch(instrument.command, argv, spawnOptions, spawnOptions.env ?? {});
  const wallMs = performance.now() - startedAt;

  return {
    wallMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...classifyExit(result),
  };
}

/**
 * The child's environment: **inherited, except arm-owned keys** — see `arm-env.ts`.
 *
 * Inheriting `process.env` is load-bearing, not hygiene. The I/O facet works
 * by setting `NODE_OPTIONS=--require <preload>`, and vat's own launcher spawns
 * a SECOND node process for the real binary — the preload propagates to that
 * descendant through the inherited environment. A harness that handed
 * `spawnSync` only the arm's own variables would strip everything else
 * (`PATH`, `HOME`, `NODE_OPTIONS` set by the surrounding shell) and the facet
 * would silently measure the launcher alone, reporting a plausible number for
 * the wrong process.
 *
 * The arm-owned keys are the one exception, in the other direction: a
 * `VAT_BIN` or `VAT_ROOT_DIR` exported in the operator's shell would reach both
 * arms of an A/B and make them one build. They reach a child only when the arm
 * sets them, and the arm's `unset` removes anything else it must run without.
 *
 * @param env - The arm's environment
 * @returns The environment to hand the child
 */
function buildEnv(env: RunOptions['env']): NodeJS.ProcessEnv {
  return buildArmEnv(process.env, env);
}

/**
 * Resolve the command the way utils does, then spawn it.
 *
 * Both halves are utils' decisions, deliberately:
 *
 * - **Resolution** is `isPathLike(command) ? command : <the child's PATH>`.
 *   An explicit path is spawned as given, so a nonexistent one surfaces as
 *   `spawnSync`'s own `ENOENT`; a bare name (`npx`, `git`, a prerequisite's
 *   `pnpm`) is looked up by {@link resolveOnPath} on the CHILD's PATH and
 *   nowhere else — not with `which`, which on Windows searches the lab's own
 *   working directory first and reads the lab's PATH, not the child's.
 * - **Shell mode** is `shouldUseShell(resolved)` — true only for a resolved
 *   `.cmd`/`.bat`/`.ps1` on Windows, which since the CVE-2024-27980 fix Node
 *   refuses to launch without a shell. On Windows a bare `npx` resolves to
 *   `npx.cmd` and takes that branch; a bare `node` resolves to `node.exe` and
 *   does not. Everything else on every platform gets `shell: false` and a real
 *   argv array — the mode with no metacharacter surface at all. The shell line
 *   names the RESOLVED file ({@link windowsShellLine}).
 *
 * @param command - The executable, as the instrument named it
 * @param args - Full argument vector (leading args already prepended)
 * @param options - Prepared `spawnSync` options
 * @param env - The child's environment, whose PATH resolves a bare name
 * @returns The `spawnSync` result, or {@link unspawned} when resolution failed
 */
function launch(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const resolved = isPathLike(command) ? command : resolveOnPath(command, env, process.platform);
  if (resolved === undefined) {
    // A spawn failure like any other: it rejoins the single classification path
    // rather than becoming a second way for a run to fail.
    return unspawned(new Error('no absolute entry of the child’s PATH holds it'), `could not resolve command '${command}' on PATH`);
  }

  if (!shouldUseShell(resolved)) {
    return spawnSync(resolved, [...args], { ...options, shell: false });
  }
  return spawnSync(windowsShellLine(resolved, args), { ...options, shell: true });
}

/** What Windows tries when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Find a bare command name on a PATH, the way the OS would — minus every
 * directory PATH does not name absolutely. A relative or empty entry is read
 * against a working directory, and a working directory here is the subject's
 * clone, so neither is searched.
 *
 * @param command - A bare name (`git`, `pnpm`), never a path
 * @param env - The environment whose PATH (and, on Windows, `PATHEXT`) decides; names case-insensitive on Windows
 * @param platform - Whose rules: `;`, `PATHEXT` and existence on `win32`; `:` and the execute bit elsewhere
 * @returns The first file found, or `undefined`
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const windows = platform === 'win32';
  const value = envValue(env, platform);
  const entries = (value('PATH') ?? '').split(windows ? ';' : ':');
  const isAbsolute = windows ? win32.isAbsolute : posix.isAbsolute;
  const extensions = windows ? (value('PATHEXT') ?? DEFAULT_PATHEXT).split(';').filter((ext) => ext !== '') : [];
  // A name with an extension is tried as given first, as Windows does.
  const names = windows ? [...(command.includes('.') ? [command] : []), ...extensions.map((ext) => command + ext)] : [command];
  for (const entry of entries) {
    if (entry === '' || !isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = safePath.join(entry, name);
      if (isLaunchable(candidate, entry, windows)) return candidate;
    }
  }
  return undefined;
}

/**
 * @param env - An environment
 * @param platform - Whose name rules
 * @returns A reader of one variable, matching its name case-insensitively on Windows
 */
function envValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): (name: string) => string | undefined {
  const spell = envNameSpelling(platform);
  return (name) => Object.entries(env).find(([key]) => spell(key) === spell(name))?.[1];
}

/**
 * @param path - A candidate file
 * @param entry - The PATH entry it is under, beneath which its links are walked
 * @param windows - Whether existence alone makes it launchable
 * @returns Whether it is a file the OS would run; absent, unsearchable, a dangling link or (POSIX) not executable is `false`
 * @throws a link chain VAT will not hand the kernel, and any fault but a refusal
 */
function isLaunchable(path: string, entry: string, windows: boolean): boolean {
  let stat: ReturnType<typeof followedStatSync>;
  try {
    stat = followedStatSync(path, entry);
  } catch (error: unknown) {
    // An entry this user may not search: execvp passes it over and tries the next.
    if (fsFaultOf(error)?.faultClass === 'refused') return false;
    throw error;
  }
  if (stat?.isFile() !== true) return false;
  if (windows) return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (error: unknown) {
    // Not executable by this user: the OS would pass it over too. Anything else is not that.
    if (fsFaultOf(error)?.faultClass === 'refused') return false;
    throw error;
  }
}

/**
 * The one `cmd.exe` line for a resolved `.cmd`/`.bat`/`.ps1`. Node's DEP0190
 * rejects `shell: true` beside a separate args array, so the command and its
 * arguments are one line, each argument quoted by utils' `windowsShellQuote`.
 * The command is the RESOLVED file, quoted, never the bare name: `cmd.exe`
 * looks a bare name up in the child's working directory before PATH.
 *
 * @param resolved - The file {@link resolveOnPath} found, or an explicit path
 * @param args - Full argument vector
 * @returns The line
 */
export function windowsShellLine(resolved: string, args: readonly string[]): string {
  return buildWindowsShellLine(resolveShellCommandToken(resolved, resolved), [...args]);
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
