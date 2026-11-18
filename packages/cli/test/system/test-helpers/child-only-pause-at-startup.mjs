/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised CHILD writes its pid, then
 * pauses for a while before the CLI loads, then runs on as normal — so a case can act on a run whose
 * child is certainly alive, and still see it finish.
 *
 * - `TEST_STARTUP_MARKER` (required): where the child writes its pid before it pauses.
 * - `TEST_CHILD_PAUSE_MS` (required): how long it pauses. The pause is `Atomics.wait` with a
 *   timeout, measured on the monotonic clock, so time the process spends stopped counts toward it.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';

if (process.argv.includes('--supervised-by')) {
  const marker = process.env['TEST_STARTUP_MARKER'];
  const pause = Number(process.env['TEST_CHILD_PAUSE_MS']);
  if (marker === undefined) throw new Error('child-only-pause-at-startup.mjs needs TEST_STARTUP_MARKER');
  if (!Number.isFinite(pause) || pause <= 0) throw new Error('child-only-pause-at-startup.mjs needs TEST_CHILD_PAUSE_MS');
  fs.writeFileSync(marker, String(process.pid), 'utf-8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
}
