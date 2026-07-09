/* c8 ignore file — pure re-export barrel, no logic to cover */
/**
 * @vibe-agent-toolkit/utils/process
 *
 * Narrow subpath export for process/command-execution primitives. Import this
 * entry point when you need cross-platform spawn helpers without pulling in
 * the linkAuth, git, skill-testing, or macro-expansion machinery from the
 * full `"."` barrel.
 */

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
