/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): a supervised `vat resources check`
 * CHILD stalls ASYNCHRONOUSLY, forever, right after it appends its `started` progress entry — its
 * event loop keeps turning, but the population waits on I/O that never completes.
 *
 * The sibling `child-only-stall-in-population.mjs` stalls with `Atomics.wait`, which blocks the
 * thread: nothing in the child runs again, which is what a statement blocked inside SQLite looks
 * like. This one is the other shape — a population waiting on I/O — so a case can show what the
 * child does on its own while its event loop is free.
 *
 * Once `started` is on disk, every asynchronous filesystem call and child-process spawn the child
 * makes never completes, and a timer keeps the loop alive (a promise nobody will settle does not).
 * `syncBuiltinESMExports()` makes the ESM bindings the CLI imports see the patches.
 *
 * When `TEST_CHILD_PID_FILE` is set, the child writes its pid there once it has stalled.
 *
 * Acts only in the process whose argv carries `--supervised-by` (the supervised child). VAT's source
 * gains no knob for this.
 */
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

/** The asynchronous filesystem calls a population makes, in both API shapes. */
const FS_CALLS = ['access', 'lstat', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'stat'];

if (process.argv.includes('--supervised-by')) {
  let stalled = false;

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

  for (const name of ['spawn', 'execFile']) {
    const real = childProcess[name];
    childProcess[name] = (...args) => (stalled ? neverEnding() : real(...args));
  }
  for (const name of FS_CALLS) {
    const realPromise = fs.promises[name];
    if (typeof realPromise === 'function') {
      fs.promises[name] = (...args) => (stalled ? new Promise(() => {}) : realPromise(...args));
    }
    const realCallback = fs[name];
    if (typeof realCallback === 'function') {
      // The callback is simply never called.
      fs[name] = (...args) => (stalled ? undefined : realCallback(...args));
    }
  }

  const append = fs.appendFileSync;
  fs.appendFileSync = (path, data, ...rest) => {
    const result = append(path, data, ...rest);
    if (typeof data === 'string' && data.includes('"kind":"started"')) {
      stalled = true;
      setInterval(() => {}, 60_000);
      const pidFile = process.env['TEST_CHILD_PID_FILE'];
      if (pidFile !== undefined) fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
    }
    return result;
  };
  syncBuiltinESMExports();
}
