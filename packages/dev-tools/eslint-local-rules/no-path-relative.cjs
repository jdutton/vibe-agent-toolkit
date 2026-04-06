/**
 * ESLint rule: no-path-relative
 *
 * Bans path.relative() from node:path. Use safePath.relative() from @vibe-agent-toolkit/utils.
 * safePath.relative() wraps path.relative() + toForwardSlash() to prevent Windows backslash bugs.
 */
const factory = require('./path-function-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'relative',
  message:
    'Use safePath.relative() from @vibe-agent-toolkit/utils instead of path.relative(). ' +
    'path.relative() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
});
