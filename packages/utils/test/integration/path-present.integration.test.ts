/**
 * `pathPresent`: absent is `false` and only absent — a path the OS will not let the
 * caller examine is a classified fault on the caller's side, never "nothing there"
 * (what `existsSync` answers for both).
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FS_FAULT_CODE, FS_SIDES } from '../../src/errors/fs-fault.js';
import { pathPresent } from '../../src/errors/path-present.js';
import { safePath } from '../../src/path-core.js';
import { mkdirSyncReal } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs, type FaultFsSession } from '../../src/testing/fault-fs.js';
import { CANNOT_DENY_READS } from '../../src/testing/platform-gates.js';
import { registerScratchTmpdir } from '../../src/testing/temp-dir.js';

// Every tree below lives in a per-test scratch that is also TMPDIR/TEMP/TMP.
const scratch = registerScratchTmpdir('path-present-', { beforeEach, afterEach });
let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
});

/** A file that is there, and a session whose first metadata call on it answers ENOENT. */
function presentFileProbedAbsent(): string {
  const file = safePath.join(scratch(), 'there.json');
  writeFileSync(file, '{}');
  session = installFaultFs({ within: scratch(), faults: [{ family: 'meta', path: (p) => p === file, errno: 'ENOENT' }] });
  return file;
}

describe('pathPresent', () => {
  it('answers true for a file and false for a path with nothing at it, in both modes', () => {
    const file = safePath.join(scratch(), 'here.txt');
    writeFileSync(file, 'x');
    const missing = safePath.join(scratch(), 'missing', 'gone.txt');
    expect([pathPresent(file, 'entry', 'source', 'probe'), pathPresent(file, 'follow', 'source', 'confirmed')]).toEqual([true, true]);
    expect([pathPresent(missing, 'entry', 'source', 'probe'), pathPresent(missing, 'follow', 'source', 'confirmed')]).toEqual([false, false]);
  });

  it('answers a dangling link present as an entry and absent when followed', ({ skip }) => {
    const cap = symlinkCapability();
    if (cap === null) {
      skip();
      return;
    }
    const link = safePath.join(scratch(), 'dangling');
    createSymlink(cap, safePath.join(scratch(), 'no-target'), link);
    expect([pathPresent(link, 'entry', 'destination', 'confirmed'), pathPresent(link, 'follow', 'destination', 'confirmed')]).toEqual([true, false]);
  });

  // The caller's `absence` argument decides, never the side: every side is asked both ways.
  describe.each(FS_SIDES)('a present entry whose probe answers ENOENT, on side %s', (side) => {
    it.each(['entry', 'follow'] as const)('is refused when the absence must be confirmed (%s): the parent lists it', (mode) => {
      const file = presentFileProbedAbsent();
      expect(() => pathPresent(file, mode, side, 'confirmed')).toThrow(
        expect.objectContaining({ code: FS_FAULT_CODE, side, errno: 'ENOENT', path: file }),
      );
    });

    it('is absent when the probe is taken at its word, and nothing is listed', () => {
      const file = presentFileProbedAbsent();
      expect(pathPresent(file, 'follow', side, 'probe')).toBe(false);
      expect(session?.calls.filter((call) => call.family === 'list')).toEqual([]);
    });
  });

  // chmod 000 does not restrict access on Windows, and root bypasses permission checks.
  it.skipIf(CANNOT_DENY_READS)('refuses a path under a directory it may not search, on the caller\'s side', () => {
    const locked = safePath.join(scratch(), 'locked');
    mkdirSyncReal(locked);
    const inside = safePath.join(locked, 'manifest.json');
    writeFileSync(inside, '{}');
    chmodSync(locked, 0o000);
    try {
      expect(() => pathPresent(inside, 'follow', 'destination', 'probe')).toThrow(
        expect.objectContaining({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused', errno: 'EACCES', path: inside }),
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
