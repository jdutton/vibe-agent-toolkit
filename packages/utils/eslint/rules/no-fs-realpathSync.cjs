/**
 * ESLint rule: no-fs-realpathSync
 *
 * Prevents usage of fs.realpathSync() in favor of normalizePath() from `@vibe-agent-toolkit/utils/fs`
 *
 * Why: realpathSync() doesn't consistently resolve Windows 8.3 short paths across Node versions.
 * normalizePath() uses realpathSync.native() with fallbacks for better cross-platform compatibility.
 *
 * No auto-fix: normalizePath() takes `{ within }` — the tree the path is crawled in — which the
 * rule cannot know. A suggestion rewrites the call with `{ within: undefined }`, which fails the
 * typecheck at that spot until the author names the tree.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_FS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'realpathSync',
  unsafeModule: 'node:fs',
  safeFn: 'normalizePath',
  safeModule: SAFE_FS_MODULE,
  rewrite: {
    appendArgument: '{ within: undefined }',
    suggestion: 'Replace with normalizePath(target, { within: undefined }), then set `within` to the tree the path is crawled in',
  },
  message:
    'Use normalizePath(target, { within }) from {{safeModule}} instead of fs.realpathSync() for consistent Windows 8.3 path resolution; ' +
    '`within` is the tree the path is crawled in, or the path itself when it is the operator\'s own',
  // No baked-in exemption: the file that implements normalizePath() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
  docs: {
    category: 'Filesystem and process',
    bans: '`fs.realpathSync()`',
    useInstead: '`normalizePath(target, { within })`',
    subpath: '/fs',
    recommended: true,
    recommendedSeverity: 'error',
  },
});
