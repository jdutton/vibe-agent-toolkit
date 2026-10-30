/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process's watchdog poll
 * throws — its `stat` of the progress log fails with `EACCES` — once the child has written its pid
 * to `TEST_CHILD_PID_FILE` (see `child-only-stall-in-population.mjs`).
 *
 * The poll runs in a timer, so the throw is uncaught and the CLI's last-resort handler ends the
 * process with `process.exit` — the ending no signal handler sees. Gated on the pid file so the
 * case can find the child it then asserts is gone.
 *
 * Acts only in a process whose argv does NOT carry `--cost-log` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const pidFile = process.env['TEST_CHILD_PID_FILE'];

if (!process.argv.includes('--cost-log') && pidFile !== undefined) {
  const stat = fs.statSync;
  fs.statSync = (path, ...rest) => {
    if (String(path).endsWith('progress.jsonl') && fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8') !== '') {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${String(path)}'`), { code: 'EACCES', syscall: 'stat', path });
    }
    return stat(path, ...rest);
  };
  syncBuiltinESMExports();
}
