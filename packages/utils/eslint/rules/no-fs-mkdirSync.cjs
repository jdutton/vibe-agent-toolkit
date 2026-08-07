/**
 * ESLint rule: no-fs-mkdirSync
 *
 * Prevents usage of fs.mkdirSync() in favor of mkdirSyncReal() from `@vibe-agent-toolkit/utils/fs`
 *
 * Why: After mkdirSync(), the path might not match what the filesystem uses on Windows.
 * mkdirSyncReal() returns the real (normalized) path to handle 8.3 short name issues.
 *
 * Auto-fix: Replaces fs.mkdirSync() with mkdirSyncReal() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_FS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'mkdirSync',
  unsafeModule: 'node:fs',
  safeFn: 'mkdirSyncReal',
  safeModule: SAFE_FS_MODULE,
  message: 'Use mkdirSyncReal() from {{safeModule}} instead of fs.mkdirSync() for Windows path normalization',
  // No baked-in exemption: the file that implements mkdirSyncReal() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
});
