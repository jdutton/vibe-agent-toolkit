/**
 * ESLint rule: no-child-process-execSync
 *
 * Prevents usage of child_process.execSync() in favor of safeExecSync() from `@vibe-agent-toolkit/utils/process`
 *
 * Why: execSync() uses shell interpreter which enables command injection attacks.
 * safeExecSync() uses direct spawn (no shell) with 'which' pattern for security.
 *
 * No auto-fix: execSync() takes a shell string, safeExecSync() a binary and an argument
 * array. Swapping the callee compiles and changes what the string means (`'ls -la'` becomes
 * a binary named `ls -la`), and splitting a shell string is not something a fixer can do
 * safely. A suggestion rewrites the callee and appends `ARGV_FROM_SHELL_STRING`, an unbound
 * name that fails the typecheck until the author splits the command.
 */

const factory = require('./eslint-rule-factory.cjs');
const { SAFE_PROCESS_MODULE } = require('./safe-import.cjs');

module.exports = factory({
  unsafeFn: 'execSync',
  unsafeModule: 'node:child_process',
  safeFn: 'safeExecSync',
  safeModule: SAFE_PROCESS_MODULE,
  rewrite: {
    appendArgument: 'ARGV_FROM_SHELL_STRING',
    suggestion:
      'Replace with safeExecSync(command, ARGV_FROM_SHELL_STRING), then split the shell string: the binary as the first argument, its arguments as the array',
  },
  message:
    'Use safeExecSync(binary, args) from {{safeModule}} instead of child_process.execSync() to prevent command injection (security + cross-platform); ' +
    'it takes a binary and an argument array, not a shell string',
  // No baked-in exemption: the file that implements safeExecSync() is
  // repo-specific. Consumers declare it as { exemptFiles: [...] }.
  docs: {
    category: 'Filesystem and process',
    bans: '`child_process.execSync()`',
    useInstead: '`safeExecSync(binary, args)`',
    subpath: '/process',
    recommended: true,
    recommendedSeverity: 'error',
  },
});
