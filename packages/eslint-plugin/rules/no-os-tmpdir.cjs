/**
 * ESLint rule: no-os-tmpdir
 *
 * Prevents usage of os.tmpdir() in favor of normalizedTmpdir() from @vibe-agent-toolkit/utils
 *
 * Why: os.tmpdir() returns Windows 8.3 short paths (RUNNER~1) which cause module loading
 * errors when paths are passed to child processes or used with import statements.
 *
 * Auto-fix: Replaces os.tmpdir() with normalizedTmpdir() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'tmpdir',
  unsafeModule: 'node:os',
  safeFn: 'normalizedTmpdir',
  safeModule: '@vibe-agent-toolkit/utils',
  message: 'Use normalizedTmpdir() from @vibe-agent-toolkit/utils instead of os.tmpdir() for Windows compatibility (prevents 8.3 short name issues like RUNNER~1)',
  // No baked-in exemption: the file that implements normalizedTmpdir() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
  checkMemberExpression: true, // Catch os.tmpdir() pattern
});
