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

export {
  shouldUseShell,
  windowsShellQuote,
  buildWindowsShellLine,
  isPathLike,
  resolveShellCommandToken,
} from './windows-shell.js';
