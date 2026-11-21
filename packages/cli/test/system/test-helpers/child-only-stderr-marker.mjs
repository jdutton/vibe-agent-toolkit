/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD writes its pid to `VAT_TEST_CHILD_PID_FILE` and then {@link MARKER} to its stderr, at
 * startup.
 *
 * The marker is a line only the child prints, at a moment the case controls: so where it lands in
 * the run's stderr (after the checks banner, before the parent's findings) shows whether an
 * overlapped child's held stderr was replayed at its turn, from its first byte, and in full. The
 * pid file lets a case ask whether the child is still alive.
 *
 * - `VAT_TEST_CHILD_SPEAK_FILE`: the child holds the marker back until this file exists, so a
 *   case can make it speak AFTER the checks turn has started.
 * - `VAT_TEST_CHILD_RELEASE_FILE`: having spoken, the child holds until this file exists, so a
 *   case can see the line arrive while the child is still running.
 * - `VAT_TEST_CHILD_EXIT_FILE`: the child creates it in its `exit` handler.
 *
 * A hold blocks the thread (`Atomics.wait` between looks for the file), with {@link MAX_HOLD_MS}
 * as a ceiling so an abandoned child cannot block forever. The marker is written with
 * `fs.writeSync` on fd 2, so its bytes are in the child's stderr (a file, when overlapped) before
 * it does anything else.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';

/** The line the child writes. */
const MARKER = 'VAT-TEST-CHILD-MARKER\n';
/** Ceiling on a hold, below the system tier's per-test timeout. */
const MAX_HOLD_MS = 60_000;
/** One synchronous wait between looks for the file. */
const SLICE_MS = 20;

/** Block the thread until `file` exists (a no-op when no file is named), or the ceiling passes. */
function holdUntil(file) {
  if (file === undefined) return;
  const slot = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + MAX_HOLD_MS;
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(slot, 0, 0, SLICE_MS);
}

if (process.argv.includes('--supervised-by')) {
  const pidFile = process.env['VAT_TEST_CHILD_PID_FILE'];
  const exitFile = process.env['VAT_TEST_CHILD_EXIT_FILE'];
  if (pidFile !== undefined) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
  if (exitFile !== undefined) process.on('exit', () => fs.writeFileSync(exitFile, '', 'utf-8'));
  holdUntil(process.env['VAT_TEST_CHILD_SPEAK_FILE']);
  fs.writeSync(2, MARKER);
  holdUntil(process.env['VAT_TEST_CHILD_RELEASE_FILE']);
}
