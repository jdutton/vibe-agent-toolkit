/**
 * ESLint rule: no-fs-realpathSync
 *
 * Prevents usage of fs.realpathSync() in favor of normalizePath() from `@vibe-agent-toolkit/utils/fs`
 *
 * Why: realpathSync() doesn't consistently resolve Windows 8.3 short paths across Node versions.
 * normalizePath() uses realpathSync.native() with fallbacks for better cross-platform compatibility.
 *
 * Auto-fix: Replaces fs.realpathSync() with normalizePath() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_FS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'realpathSync',
  unsafeModule: 'node:fs',
  safeFn: 'normalizePath',
  safeModule: SAFE_FS_MODULE,
  message: 'Use normalizePath() from {{safeModule}} instead of fs.realpathSync() for consistent Windows 8.3 path resolution',
  // No baked-in exemption: the file that implements normalizePath() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
});
