/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD blocks its thread inside its FIRST check — right after it appends that check's `start`
 * progress entry — until the case RELEASES it by creating `TEST_CHILD_RELEASE_FILE`, and then
 * carries on as normal. So a case can end the supervisor while the synchronous check loop runs,
 * and see what the child does once the check returns.
 *
 * Held until released, not for a fixed time: with a fixed hold the runner decided the case. Once
 * the gap between the pid write and the supervisor's SIGKILL passed the hold (a loaded runner,
 * another worker spawning beside it), the child had moved on to its next check and the case
 * failed for timing, not behaviour. {@link MAX_HOLD_MS} is only a ceiling so an abandoned child
 * cannot block forever.
 *
 * `Atomics.wait` blocks the thread the way a slow SQLite statement does: nothing in the child runs
 * meanwhile, I/O included — the release file is looked for synchronously between short waits. The
 * progress writer is a synchronous `appendFileSync`; `syncBuiltinESMExports()` makes the ESM
 * `node:fs` binding it imports see the patch.
 *
 * - `TEST_CHILD_PID_FILE`: the child writes its pid there just before it blocks.
 * - `TEST_CHILD_RELEASE_FILE` (required): the check returns once this file exists.
 * - `TEST_CHILD_TRACE_FILE`: the child appends `published` there the first time it writes to
 *   stdout (the document — nothing else in the child writes stdout), and `exit:<code>` as it exits.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** Ceiling on the hold, below the system tier's per-test timeout. */
const MAX_HOLD_MS = 60_000;
/** One synchronous wait between looks for the release file. */
const SLICE_MS = 20;

if (process.argv.includes('--supervised-by')) {
  const release = process.env['TEST_CHILD_RELEASE_FILE'];
  if (release === undefined) throw new Error('child-only-slow-check.mjs needs TEST_CHILD_RELEASE_FILE');
  const trace = process.env['TEST_CHILD_TRACE_FILE'];
  const append = fs.appendFileSync;
  let blocked = false;

  if (trace !== undefined) {
    const write = process.stdout.write.bind(process.stdout);
    let published = false;
    process.stdout.write = (...args) => {
      if (!published) {
        published = true;
        append(trace, 'published\n', 'utf-8');
      }
      return write(...args);
    };
    process.on('exit', (code) => {
      append(trace, `exit:${String(code)}\n`, 'utf-8');
    });
  }

  fs.appendFileSync = (path, data, ...rest) => {
    const result = append(path, data, ...rest);
    if (!blocked && typeof data === 'string' && data.includes('"kind":"start"')) {
      blocked = true;
      const pidFile = process.env['TEST_CHILD_PID_FILE'];
      if (pidFile !== undefined) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
      const slot = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + MAX_HOLD_MS;
      while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(slot, 0, 0, SLICE_MS);
    }
    return result;
  };
  syncBuiltinESMExports();
}
