/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD stalls, synchronously, right after it appends its `started` progress entry — so the
 * watchdog's kill lands during the population, deterministically.
 *
 * The progress writer is a synchronous `appendFileSync`, which a promise cannot block, so the
 * preload patches `fs.appendFileSync` and, once the call carrying `started` returns, blocks the
 * thread with `Atomics.wait` on a buffer nothing ever notifies. `syncBuiltinESMExports()` makes
 * the ESM `node:fs` binding the writer imports see the patch.
 *
 * - `TEST_CHILD_PID_FILE`: the child writes its pid there before it stalls, so a case can tell
 *   whether the stalled child outlived its supervisor.
 * - `TEST_CHILD_MAX_STALL_MS` (required): the stall's ceiling. Past it the child kills itself
 *   (SIGKILL; `TerminateProcess` on Windows), so no exit handler runs and it publishes nothing. The
 *   case sets it well past the bound it asserts — a child the supervisor failed to kill still fails
 *   the case — and the child cannot outlive the run if it escaped teardown too (on Windows teardown
 *   kills the supervisor only and relies on the job object to take the child). Required, because
 *   only the case knows its bound: a bound measured on the machine can outgrow any fixed ceiling.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv.includes('--supervised-by')) {
  const ceiling = Number(process.env['TEST_CHILD_MAX_STALL_MS']);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('child-only-stall-in-population.mjs needs TEST_CHILD_MAX_STALL_MS');
  const append = fs.appendFileSync;
  fs.appendFileSync = (path, data, ...rest) => {
    const result = append(path, data, ...rest);
    if (typeof data === 'string' && data.includes('"kind":"started"')) {
      const pidFile = process.env['TEST_CHILD_PID_FILE'];
      if (pidFile !== undefined) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ceiling);
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  };
  syncBuiltinESMExports();
}
