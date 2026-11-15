/**
 * How the system suites' `alive` reads `/proc`: a process that ended between `kill(pid, 0)` and
 * the `stat` read is gone, a host with no `/proc` leaves the answer to `kill`, and any other read
 * failure is a bug that surfaces.
 */

import { describe, expect, it } from 'vitest';

import { type ProcReader, procSaysGone } from './system/test-helpers/live-vat.js';

const PID = 4242;

/** An errno-coded error, as `readFileSync` throws it. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: read`), { code });
}

/** A mounted `/proc` whose read of `PID`'s `stat` returns `stat` or throws `failure`. */
function mountedProc(read: string | NodeJS.ErrnoException): ProcReader {
  return {
    mounted: true,
    readStat: (pid) => {
      expect(pid).toBe(PID);
      if (typeof read === 'string') return read;
      throw read;
    },
  };
}

describe('procSaysGone', () => {
  it('reads a vanished process as gone: ESRCH, and ENOENT once the entry is unlinked', () => {
    expect(procSaysGone(PID, mountedProc(errno('ESRCH')))).toBe(true);
    expect(procSaysGone(PID, mountedProc(errno('ENOENT')))).toBe(true);
  });

  it('reads state Z as gone and any other state as running, past a command holding ") "', () => {
    expect(procSaysGone(PID, mountedProc(`${String(PID)} (a) Z b) Z 1 2`))).toBe(true);
    expect(procSaysGone(PID, mountedProc(`${String(PID)} (a) Z b) S 1 2`))).toBe(false);
  });

  it('says nothing where /proc is not mounted, without reading it', () => {
    const unmounted: ProcReader = {
      mounted: false,
      readStat: () => {
        throw new Error('read on a host with no /proc');
      },
    };

    expect(procSaysGone(PID, unmounted)).toBe(false);
  });

  it('rethrows a read failure that does not mean the process is gone', () => {
    expect(() => procSaysGone(PID, mountedProc(errno('EIO')))).toThrow('EIO');
  });
});
