/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD stalls ASYNCHRONOUSLY, until its ceiling, once it has appended its `started` progress entry — its
 * event loop keeps turning, but it parks at the first continuation it would wait on. On a cold
 * store that is the population's first I/O; on a warm store, which serves the population and runs
 * every check without I/O, it is the turn of the loop just before it publishes
 * (`letSupervisorLossSurface`).
 *
 * The sibling `child-only-stall-in-population.mjs` stalls with `Atomics.wait`, which blocks the
 * thread: nothing in the child runs again, which is what a statement blocked inside SQLite looks
 * like. This one is the other shape — a population waiting on I/O — so a case can show what the
 * child does on its own while its event loop is free.
 *
 * Once `started` is on disk, every asynchronous filesystem call and child-process spawn the child
 * makes never completes, nor does any `setImmediate` callback (a warm store needs none of the
 * others), and a timer keeps the loop alive (a promise nobody will settle does not).
 * `syncBuiltinESMExports()` makes the ESM bindings the CLI imports see the patches.
 *
 * - `TEST_CHILD_PID_FILE`: the child writes its pid there once it has PARKED — the first of those
 *   continuations it swallows. A child that ran on without parking never writes it, so a case that
 *   waits on the file fails loudly instead of racing a child that is not stalled at all.
 * - `TEST_CHILD_TRACE_FILE`: the child appends `exit:<code>` there as it exits — the one way a
 *   case can read the exit code of a process that is not its own child.
 * - `TEST_CHILD_MAX_STALL_MS` (required): the stall's ceiling. Past it the child kills itself
 *   (SIGKILL; `TerminateProcess` on Windows), so no exit handler runs and no `exit:` line is
 *   traced. The case sets it well past the bound it asserts — a child that failed to end still
 *   fails the case — and the child cannot outlive the run if it escaped teardown too (on Windows
 *   teardown kills the supervisor only and relies on the job object to take the child).
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { onChildStarted } from './on-child-started.mjs';

/** The asynchronous filesystem calls a population makes, in both API shapes. */
const FS_CALLS = ['access', 'lstat', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'stat'];

if (process.argv.includes('--supervised-by')) {
  const ceiling = Number(process.env['TEST_CHILD_MAX_STALL_MS']);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('child-only-async-stall.mjs needs TEST_CHILD_MAX_STALL_MS');
  let stalled = false;
  const trace = process.env['TEST_CHILD_TRACE_FILE'];
  if (trace !== undefined) {
    process.on('exit', (code) => {
      fs.appendFileSync(trace, `exit:${String(code)}\n`, 'utf-8');
    });
  }

  /** A child process that started and will never end. */
  const neverEnding = () => {
    const stub = new EventEmitter();
    Object.assign(stub, {
      pid: 0,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [],
      kill: () => true,
      ref: () => stub,
      unref: () => stub,
    });
    return stub;
  };

  /** The child is parked: one of its continuations will never run. Its pid is written now, once. */
  let parked = false;
  const park = () => {
    if (parked) return;
    parked = true;
    const pidFile = process.env['TEST_CHILD_PID_FILE'];
    if (pidFile !== undefined) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
  };

  /** `real`, until the child stalls; then `instead()` in its place, the child parked. */
  const untilStalled = (real, instead) => (...args) => {
    if (!stalled) return real(...args);
    park();
    return instead(...args);
  };

  for (const name of ['spawn', 'execFile']) {
    childProcess[name] = untilStalled(childProcess[name], neverEnding);
  }
  for (const name of FS_CALLS) {
    if (typeof fs.promises[name] === 'function') {
      fs.promises[name] = untilStalled(fs.promises[name], () => new Promise(() => {}));
    }
    if (typeof fs[name] === 'function') {
      // The callback is simply never called.
      fs[name] = untilStalled(fs[name], () => undefined);
    }
  }
  // A warm store serves the population without any of the above, so the child would run on to
  // publish. Its callback is swallowed too: it parks at its next turn of the loop
  // (`letSupervisorLossSurface` at the latest), still reading stdin. A real immediate of nothing is
  // returned, so `clearImmediate` and `unref` still work.
  const realSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = untilStalled(realSetImmediate, () => realSetImmediate(() => {}));

  onChildStarted(() => {
    stalled = true;
    // Keeps the loop alive (a promise nobody will settle does not) until the ceiling.
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), ceiling);
  });
  syncBuiltinESMExports();
}
