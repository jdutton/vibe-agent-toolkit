/**
 * ESLint rule: no-fs-realpathSync
 *
 * Prevents usage of fs.realpathSync() in favor of normalizePath() from `@vibe-agent-toolkit/utils/fs`
 *
 * Why: realpathSync() doesn't consistently resolve Windows 8.3 short paths across Node versions.
 * normalizePath() resolves short names and links, reads every link beneath `within` by its text first
 * (refusing one into a network or device path), and returns the resolved spelling of an absent path.
 *
 * No auto-fix: normalizePath() takes `{ within }` — the tree the path is crawled in — which the
 * rule cannot know. A suggestion rewrites the call with `{ within: TREE_CRAWLED_IN }`, an unbound
 * name that fails the typecheck under any compiler options until the author names the tree.
 * With `safeModule` naming a consumer's own wrapper, whose `within` may be spelled differently,
 * the message names no call shape and no suggestion is offered.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_FS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'realpathSync',
  unsafeModule: 'node:fs',
  safeFn: 'normalizePath',
  safeModule: SAFE_FS_MODULE,
  rewrite: {
    appendArgument: '{ within: TREE_CRAWLED_IN }',
    suggestion:
      'Replace with normalizePath(target, { within: TREE_CRAWLED_IN }), then set `within` to the tree the path is crawled in. ' +
      'Unlike realpathSync(), it no longer throws when the path is absent: it returns the resolved spelling',
    seamMessage:
      'Use normalizePath from {{safeModule}} instead of fs.realpathSync() for consistent Windows 8.3 path resolution; ' +
      'pass it the tree the path is crawled in, or the path itself when it is the operator\'s own',
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
