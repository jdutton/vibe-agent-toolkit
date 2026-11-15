/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): `vat audit <git url>` is held at a
 * chosen point once its tempdir exists — and its disposal of that tempdir is SLOW — so a case can
 * deliver a signal there and a second one while the tempdir is being removed.
 *
 * `TEST_STALL_AT` picks the point; either way the process writes `ready` to `TEST_READY_FILE` once
 * it is held there:
 * - `audit` (the default): the clone is complete and the audit has begun. Every asynchronous read the
 *   audit makes after the clone's `rev-parse` never completes (a timer keeps the loop alive, so a
 *   signal handler still runs).
 * - `git`: INSIDE the clone step, in a subprocess of the run's process group — as a terminal's Ctrl-C
 *   finds a real `git`. The clone's `read-tree` is replaced by a `node` that idles for 10 s, so a
 *   signal to the group kills it and the clone step FAILS of that signal.
 *
 * `fs.promises.rm` — what the disposal removes the tempdir with — waits `TEST_RM_DELAY_MS` (default
 * 1000) before it starts, so the cleanup a signal begins is still running when the next signal
 * arrives. The removal's own calls (`lstat`, `chmod`, `rm`, `rmdir`) are never stalled.
 * `syncBuiltinESMExports()` makes the ESM bindings the CLI imports see the patches. Acts only in a
 * process whose argv carries `audit`. VAT's source gains no knob for this.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** The asynchronous reads an audit makes — never the removal's own calls. */
const STALLED = ['access', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'stat'];

function announceReady() {
  const ready = process.env['TEST_READY_FILE'];
  if (ready !== undefined) fs.writeFileSync(ready, 'ready', 'utf-8');
}

if (process.argv.includes('audit')) {
  const stallAtGit = process.env['TEST_STALL_AT'] === 'git';
  let cloned = false;
  let announced = false;
  const realSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = (...args) => {
    const gitArgs = Array.isArray(args[1]) ? args[1] : [];
    if (stallAtGit && gitArgs.includes('read-tree')) {
      announceReady();
      return realSpawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { encoding: 'utf-8' });
    }
    const result = realSpawnSync(...args);
    if (gitArgs.includes('rev-parse')) cloned = true;
    return result;
  };
  if (!stallAtGit) {
    for (const name of STALLED) {
      const real = fs.promises[name];
      fs.promises[name] = (...args) => {
        if (!cloned) return real(...args);
        if (!announced) {
          announced = true;
          setInterval(() => {}, 60_000);
          announceReady();
        }
        return new Promise(() => {});
      };
    }
  }
  const realRm = fs.promises.rm;
  const delayMs = Number(process.env['TEST_RM_DELAY_MS'] ?? '1000');
  fs.promises.rm = (...args) => new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => realRm(...args));
  syncBuiltinESMExports();
}
