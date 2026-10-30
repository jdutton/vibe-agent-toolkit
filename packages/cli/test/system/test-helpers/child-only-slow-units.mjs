/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD takes `TEST_UNIT_DELAY_MS` longer over every unit — it sleeps after each progress entry it
 * appends — so a run over many checks keeps appending for many seconds. It is never blocked in
 * SQLite: it is a healthy, slow run that reaches its progress writer again and again.
 *
 * When `TEST_CHILD_PID_FILE` is set, the child writes its pid there once its `started` entry is on
 * disk, so a case can act on its supervisor while the child still has most of its work ahead.
 *
 * The progress writer is a synchronous `appendFileSync`, so the preload patches it and sleeps with
 * `Atomics.wait`; `syncBuiltinESMExports()` makes the ESM `node:fs` binding the writer imports see
 * the patch.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const delayMs = Number(process.env['TEST_UNIT_DELAY_MS']);

if (process.argv.includes('--supervised-by') && Number.isFinite(delayMs) && delayMs > 0) {
  const append = fs.appendFileSync;
  fs.appendFileSync = (path, data, ...rest) => {
    const result = append(path, data, ...rest);
    if (typeof data === 'string' && String(path).endsWith('progress.jsonl')) {
      const pidFile = process.env['TEST_CHILD_PID_FILE'];
      if (pidFile !== undefined && data.includes('"kind":"started"')) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    return result;
  };
  syncBuiltinESMExports();
}
