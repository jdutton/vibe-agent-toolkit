/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process's clock runs
 * `TEST_PARENT_CLOCK_SCALE` times faster from the moment it spawns a `vat resources check` child.
 *
 * An orchestrator's `checks` phase runs its child under the default bound (300 s) and accepts no
 * flag to change it, so a system test of a kill would wait five minutes. The watchdog measures
 * silence with `Date.now()`, so scaling that clock in the parent — and only after the spawn, so the
 * phases before it run on real time — makes the default bound elapse in `300 / scale` real
 * seconds. The test derives `scale` from `measureBudget()`, exactly as a standalone kill case
 * derives its `--budget`. The child's own clock is untouched.
 *
 * Acts only in a process whose argv does NOT carry `--cost-log` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const scale = Number(process.env['TEST_PARENT_CLOCK_SCALE']);

if (!process.argv.includes('--cost-log') && Number.isFinite(scale) && scale > 0) {
  const realNow = Date.now.bind(Date);
  let since;
  Date.now = () => (since === undefined ? realNow() : since + (realNow() - since) * scale);

  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, ...rest) => {
    if (since === undefined && Array.isArray(args) && args.includes('--cost-log')) since = realNow();
    return spawn(command, args, ...rest);
  };
  syncBuiltinESMExports();
}
