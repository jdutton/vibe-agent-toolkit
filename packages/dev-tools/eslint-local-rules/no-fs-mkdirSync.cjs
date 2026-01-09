/**
 * ESLint rule: no-fs-mkdirSync
 *
 * Prevents usage of fs.mkdirSync() in favor of mkdirSyncReal() from @vibe-agent-toolkit/utils
 *
 * Why: After mkdirSync(), the path might not match what the filesystem uses on Windows.
 * mkdirSyncReal() returns the real (normalized) path to handle 8.3 short name issues.
 *
 * Auto-fix: Replaces fs.mkdirSync() with mkdirSyncReal() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'mkdirSync',
  unsafeModule: 'node:fs',
  safeFn: 'mkdirSyncReal',
  safeModule: '@vibe-agent-toolkit/utils',
  message: 'Use mkdirSyncReal() from @vibe-agent-toolkit/utils instead of fs.mkdirSync() for Windows path normalization',
  exemptFile: 'path-utils.ts', // Implementation file
});
