/**
 * ESLint rule: no-path-resolve
 *
 * Bans path.resolve() from node:path. Use safePath.resolve() from @vibe-agent-toolkit/utils.
 * safePath.resolve() wraps path.resolve() + toForwardSlash() to prevent Windows backslash bugs.
 */
const factory = require('./path-function-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'resolve',
  message:
    'Use safePath.resolve() from @vibe-agent-toolkit/utils instead of path.resolve(). ' +
    'path.resolve() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
});
