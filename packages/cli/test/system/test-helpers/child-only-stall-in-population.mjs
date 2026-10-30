/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD stalls, synchronously and forever, right after it appends its `started` progress entry —
 * so the watchdog's kill lands during the population, deterministically.
 *
 * The progress writer is a synchronous `appendFileSync`, which a promise cannot block, so the
 * preload patches `fs.appendFileSync` and, once the call carrying `started` returns, blocks the
 * thread with `Atomics.wait` on a buffer nothing ever notifies. `syncBuiltinESMExports()` makes
 * the ESM `node:fs` binding the writer imports see the patch.
 *
 * Acts only in the process whose argv carries `--cost-log` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv.includes('--cost-log')) {
  const append = fs.appendFileSync;
  fs.appendFileSync = (path, data, ...rest) => {
    const result = append(path, data, ...rest);
    if (typeof data === 'string' && data.includes('"kind":"started"')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return result;
  };
  syncBuiltinESMExports();
}
