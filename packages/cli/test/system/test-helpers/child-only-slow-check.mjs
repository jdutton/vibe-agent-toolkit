/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD blocks its thread for `TEST_CHILD_BLOCK_MS` (default 1500) inside its FIRST check — right
 * after it appends that check's `start` progress entry — and then carries on as normal. So a case
 * can end the supervisor while the synchronous check loop runs, and see what the child does once
 * the check returns.
 *
 * `Atomics.wait` blocks the thread the way a slow SQLite statement does: nothing in the child runs
 * meanwhile, I/O included. The progress writer is a synchronous `appendFileSync`;
 * `syncBuiltinESMExports()` makes the ESM `node:fs` binding it imports see the patch.
 *
 * - `TEST_CHILD_PID_FILE`: the child writes its pid there just before it blocks.
 * - `TEST_CHILD_TRACE_FILE`: the child appends `published` there the first time it writes to
 *   stdout (the document — nothing else in the child writes stdout), and `exit:<code>` as it exits.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv.includes('--supervised-by')) {
  const blockMs = Number(process.env['TEST_CHILD_BLOCK_MS'] ?? '1500');
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
    }
    return result;
  };
  syncBuiltinESMExports();
}
