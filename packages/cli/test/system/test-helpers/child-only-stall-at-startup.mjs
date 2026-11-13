/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised CHILD stalls before the
 * CLI has loaded at all — so it never writes its `started` progress entry, and the watchdog's kill
 * lands during startup, deterministically.
 *
 * - `TEST_STARTUP_MARKER` (required): the child writes its pid there before it stalls, so a case can
 *   tell a child was spawned at all — an in-process run never reaches this preload's body.
 * - `TEST_CHILD_MAX_STALL_MS` (required): the stall's ceiling. Past it the child kills itself
 *   (SIGKILL; `TerminateProcess` on Windows), so it publishes nothing. A case sets it well past the
 *   bound it asserts, so a child the supervisor failed to kill still fails the case.
 *
 * The thread is blocked with `Atomics.wait` on a buffer nothing notifies: nothing in the child runs
 * again, which is what a boot wedged on a loaded machine looks like to its supervisor.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';

if (process.argv.includes('--supervised-by')) {
  const marker = process.env['TEST_STARTUP_MARKER'];
  const ceiling = Number(process.env['TEST_CHILD_MAX_STALL_MS']);
  if (marker === undefined) throw new Error('child-only-stall-at-startup.mjs needs TEST_STARTUP_MARKER');
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('child-only-stall-at-startup.mjs needs TEST_CHILD_MAX_STALL_MS');
  fs.writeFileSync(marker, String(process.pid), 'utf-8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ceiling);
  process.kill(process.pid, 'SIGKILL');
}
