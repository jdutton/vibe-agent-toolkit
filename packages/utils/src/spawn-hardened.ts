import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import which from 'which';

import { isAbsoluteAnyPlatform } from './path-utils.js';
import { buildWindowsShellLine, shouldUseShell, windowsShellQuote } from './windows-shell.js';

/**
 * A `command` is treated as an explicit path (used verbatim, never PATH-resolved)
 * when it is absolute or contains a path separator. A bare name (`claude`, `npm`,
 * `git`) is resolved on PATH via `which.sync`. This mirrors — and preserves — the
 * behaviour callers relied on before hardening: an explicit `binPath` is spawned
 * as-given (so a nonexistent path still surfaces as an async `'error'` event, not a
 * synchronous `which` throw), while a bare command is looked up.
 */
function isPathLike(command: string): boolean {
  return isAbsoluteAnyPlatform(command) || command.includes('/') || command.includes('\\');
}

/**
 * Cross-platform hardened async `spawn`, returning a live {@link ChildProcess} with
 * streaming stdio intact (unlike the sync, buffered {@link ./safe-exec.ts} path).
 *
 * The one thing it does that a bare `child_process.spawn` does not: correctly launch
 * Windows `.cmd`/`.bat`/`.ps1` wrappers. Since the CVE-2024-27980 fix, `spawn` throws
 * `EINVAL` on such a wrapper unless `shell: true` — and npm-installed CLIs (`claude`,
 * `npm`, …) resolve to exactly that on Windows. When shell mode is required we join the
 * command + args into a SINGLE string with per-arg {@link windowsShellQuote} (Node's
 * DEP0190 rejects `shell: true` with a separate args array); everywhere else we spawn
 * `shell: false` with the resolved absolute path, keeping the no-injection guarantee.
 *
 * POSIX is a pure passthrough to `child_process.spawn` (`shouldUseShell` is always
 * false off-Windows), so process-group / `detached` semantics are unchanged there.
 *
 * @param command - Bare command name (PATH-resolved) or an explicit path (used as-is).
 * @param args - Arguments, passed as an array (never string-concatenated on POSIX).
 * @param options - Standard `SpawnOptions` (cwd, env, stdio, detached, …), passed through.
 */
export function spawnHardened(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const resolved = isPathLike(command) ? command : which.sync(command);

  if (!shouldUseShell(resolved)) {
    return spawn(resolved, args, { ...options, shell: false });
  }

  // Windows shell path (.cmd/.bat/.ps1). Use the bare command for a PATH lookup (cmd.exe
  // re-resolves it via PATHEXT); use the quoted resolved path when given an explicit path.
  const shellCommand = isPathLike(command) ? windowsShellQuote(resolved) : command;
  const shellLine = buildWindowsShellLine(shellCommand, args);
  // eslint-disable-next-line sonarjs/os-command -- Windows DEP0190 workaround: command is a PATH-resolved bare name or an explicit path; args are per-arg shell-quoted via windowsShellQuote()
  return spawn(shellLine, { ...options, shell: true });
}
