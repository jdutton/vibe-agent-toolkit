/**
 * ESLint rule: no-fs-realpathSync
 *
 * Prevents usage of fs.realpathSync() in favor of normalizePath() from @vibe-agent-toolkit/utils
 *
 * Why: realpathSync() doesn't consistently resolve Windows 8.3 short paths across Node versions.
 * normalizePath() uses realpathSync.native() with fallbacks for better cross-platform compatibility.
 *
 * Auto-fix: Replaces fs.realpathSync() with normalizePath() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'realpathSync',
  unsafeModule: 'node:fs',
  safeFn: 'normalizePath',
  safeModule: '@vibe-agent-toolkit/utils',
  message: 'Use normalizePath() from @vibe-agent-toolkit/utils instead of fs.realpathSync() for consistent Windows 8.3 path resolution',
  exemptFile: 'path-utils.ts', // Implementation file
});
