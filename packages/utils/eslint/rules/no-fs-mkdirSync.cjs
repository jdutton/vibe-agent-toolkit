/**
 * ESLint rule: no-fs-mkdirSync
 *
 * Prevents usage of fs.mkdirSync() in favor of mkdirSyncReal() from `@vibe-agent-toolkit/utils/fs`
 *
 * Why: After mkdirSync(), the path might not match what the filesystem uses on Windows.
 * mkdirSyncReal() returns the real (normalized) path to handle 8.3 short name issues.
 *
 * Auto-fix only where the result is discarded: mkdirSyncReal() takes the same arguments but
 * returns the directory's real path, where mkdirSync() returns the first directory it created
 * (or undefined). A call whose result is used gets a suggestion instead.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_FS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'mkdirSync',
  unsafeModule: 'node:fs',
  safeFn: 'mkdirSyncReal',
  safeModule: SAFE_FS_MODULE,
  rewrite: {
    autofixAsStatement: true,
    suggestion:
      'Replace with mkdirSyncReal(), which returns the real path of the directory itself — not the first directory created, and never undefined',
  },
  message: 'Use mkdirSyncReal() from {{safeModule}} instead of fs.mkdirSync() for Windows path normalization',
  // No baked-in exemption: the file that implements mkdirSyncReal() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
  docs: {
    category: 'Filesystem and process',
    bans: '`fs.mkdirSync()`',
    useInstead: '`mkdirSyncReal()`',
    subpath: '/fs',
    recommended: true,
    recommendedSeverity: 'error',
  },
});
