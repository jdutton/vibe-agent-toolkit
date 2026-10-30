/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the process that RUNS the checks' SQL —
 * a supervised child (its argv carries `--supervised-by`), or `vat resources check --budget 0` —
 * writes its pid to `TEST_SQL_PID_FILE` the moment it starts executing a `WITH RECURSIVE`
 * statement, and then executes it for real. The statement never returns, so from that moment the
 * process is blocked inside synchronous `node:sqlite`: the state in which a signal handler would
 * take the operator's Ctrl-C away.
 *
 * Patches the `StatementSync` prototype, which every statement shares; nothing else changes. VAT's
 * source gains no knob for this.
 */
import fs from 'node:fs';

const pidFile = process.env['TEST_SQL_PID_FILE'];
const argv = process.argv;
const budgetZero = argv.some((arg, index) => arg === '--budget' && argv[index + 1] === '0');

if (pidFile !== undefined && (argv.includes('--supervised-by') || budgetZero)) {
  const { StatementSync } = await import('node:sqlite');
  for (const method of ['all', 'get', 'iterate', 'run']) {
    const original = StatementSync.prototype[method];
    StatementSync.prototype[method] = function patched(...args) {
      if (this.sourceSQL.includes('WITH RECURSIVE')) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
      return original.apply(this, args);
    };
  }
}
