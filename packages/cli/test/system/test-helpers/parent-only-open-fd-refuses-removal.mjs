/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process refuses, as
 * Windows does, to remove a directory while it holds an fd open on a file inside it.
 *
 * On Windows an open handle refuses the removal (EBUSY), so a guard that removed the progress
 * directory before closing its `stderr.log` fds would leave the directory and say so on stderr.
 * POSIX removes the directory regardless, so without this preload that ordering could not fail on
 * the platform most runs happen on. Every fd `fs.openSync` returns is remembered by path until
 * `fs.closeSync` closes it; `fs.rmSync` and `fs.promises.rm` of a directory holding one of them
 * throw EBUSY, as Windows' own refusal reads. Nothing else changes, so a run that closes its fds
 * first is unaffected. `syncBuiltinESMExports()` makes the named imports the CLI uses see the
 * patches.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { relativeEscapesRoot, safePath } from '@vibe-agent-toolkit/utils/path';

/** Open fds, by the path they were opened at. */
const open = new Map();

/** Throw Windows' refusal when `dir` holds a file this process has open. */
function refuseWhileHeld(dir, syscall) {
  for (const path of open.values()) {
    const relative = safePath.relative(String(dir), path);
    if (relative !== '' && !relativeEscapesRoot(relative)) {
      const error = new Error(`EBUSY: resource busy or locked, ${syscall} '${String(dir)}'`);
      Object.assign(error, { code: 'EBUSY', errno: -16, syscall, path: String(dir) });
      throw error;
    }
  }
}

if (!process.argv.includes('--supervised-by')) {
  const openSync = fs.openSync;
  const closeSync = fs.closeSync;
  const rmSync = fs.rmSync;
  const rm = fs.promises.rm;
  fs.openSync = (path, ...rest) => {
    const fd = openSync(path, ...rest);
    // A path given as a string (the sink's); a Buffer or URL path is not a progress-log file.
    if (typeof path === 'string') open.set(fd, path);
    return fd;
  };
  fs.closeSync = (fd) => {
    open.delete(fd);
    return closeSync(fd);
  };
  fs.rmSync = (path, ...rest) => {
    refuseWhileHeld(path, 'rmdir');
    return rmSync(path, ...rest);
  };
  fs.promises.rm = (path, ...rest) => {
    try {
      refuseWhileHeld(path, 'rmdir');
    } catch (error) {
      return Promise.reject(error);
    }
    return rm(path, ...rest);
  };
  syncBuiltinESMExports();
}
