/**
 * ESLint rule: no-path-join
 *
 * Bans path.join() from node:path. Use safePath.join() from @vibe-agent-toolkit/utils.
 * safePath.join() wraps path.join() + toForwardSlash() to prevent Windows backslash bugs.
 */
const factory = require('./path-function-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'join',
  message:
    'Use safePath.join() from @vibe-agent-toolkit/utils instead of path.join(). ' +
    'path.join() returns backslashes on Windows, causing Map key mismatches and path comparison bugs.',
});
