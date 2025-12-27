/**
 * ESLint rule: no-child-process-execSync
 *
 * Prevents usage of child_process.execSync() in favor of safeExecSync() from common.js
 *
 * Why: execSync() uses shell interpreter which enables command injection attacks.
 * safeExecSync() uses direct spawn (no shell) with 'which' pattern for security.
 *
 * Auto-fix: Replaces execSync() with safeExecSync() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');

module.exports = factory({
  unsafeFn: 'execSync',
  unsafeModule: 'node:child_process',
  safeFn: 'safeExecSync',
  safeModule: './common.js',
  message: 'Use safeExecSync() from common.js instead of child_process.execSync() to prevent command injection (security + cross-platform)',
  exemptFile: 'common.ts', // Implementation file
});
