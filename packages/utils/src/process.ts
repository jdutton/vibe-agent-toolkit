/**
 * @vibe-agent-toolkit/utils/process
 *
 * Narrow subpath export for process/command-execution primitives: sync exec,
 * stdio blocking, hardened async spawn, and Windows `.cmd`/`.bat`/`.ps1` shell
 * invocation. Import this entry point when you need cross-platform spawn
 * helpers without pulling in the linkAuth, git, skill-testing, or
 * macro-expansion machinery from the full `"."` barrel.
 */

export {
  type StdioBlockingResult,
  makeStdioBlocking,
  describeStdioBlocking,
} from './stdio-blocking.js';

export {
  type SafeExecOptions,
  type SafeExecResult,
  CommandExecutionError,
  safeExecSync,
  safeExecResult,
  isToolAvailable,
  getToolVersion,
  hasShellSyntax,
  safeExecFromString,
} from './safe-exec.js';

export { spawnHardened } from './spawn-hardened.js';

/**
 * On `./process` because "is this process running me as its entry script?" is a
 * question about the process, and because every package that has a bin or a
 * build script needs it — including ones that must not depend on the private
 * `dev-tools` package, which is where it used to live.
 */
export { isEntrypoint } from './entrypoint.js';

export {
  shouldUseShell,
  windowsShellQuote,
  buildWindowsShellLine,
  isPathLike,
  resolveShellCommandToken,
} from './windows-shell.js';
