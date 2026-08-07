/**
 * ESLint rule: no-child-process-execSync
 *
 * Prevents usage of child_process.execSync() in favor of safeExecSync() from `@vibe-agent-toolkit/utils/process`
 *
 * Why: execSync() uses shell interpreter which enables command injection attacks.
 * safeExecSync() uses direct spawn (no shell) with 'which' pattern for security.
 *
 * Auto-fix: Replaces execSync() with safeExecSync() and adds required import.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_PROCESS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'execSync',
  unsafeModule: 'node:child_process',
  safeFn: 'safeExecSync',
  safeModule: SAFE_PROCESS_MODULE,
  message: 'Use safeExecSync() from {{safeModule}} instead of child_process.execSync() to prevent command injection (security + cross-platform)',
  // No baked-in exemption: the file that implements safeExecSync() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
});
