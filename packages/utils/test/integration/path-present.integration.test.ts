/**
 * `pathPresent`: absent is `false` and only absent — a path the OS will not let the
 * caller examine is a classified fault on the caller's side, never "nothing there"
 * (what `existsSync` answers for both).
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { everywhere, FS_FAULT_CODE, FS_SIDES, sideWithin } from '../../src/errors/fs-fault.js';
import { pathPresent, type PresenceMode } from '../../src/errors/path-present.js';
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
    expect([pathPresent(file, 'entry', everywhere('source'), 'probe'), pathPresent(file, { follow: scratch() }, everywhere('source'), 'confirmed')]).toEqual([true, true]);
    expect([pathPresent(missing, 'entry', everywhere('source'), 'probe'), pathPresent(missing, { follow: scratch() }, everywhere('source'), 'confirmed')]).toEqual([false, false]);
  });

  it('answers a dangling link present as an entry and absent when followed', ({ skip }) => {
    const cap = symlinkCapability();
    if (cap === null) {
      skip();
      return;
    }
    const link = safePath.join(scratch(), 'dangling');
    createSymlink(cap, safePath.join(scratch(), 'no-target'), link);
    expect([pathPresent(link, 'entry', everywhere('destination'), 'confirmed'), pathPresent(link, { follow: scratch() }, everywhere('destination'), 'confirmed')]).toEqual([true, false]);
  });

  // The caller's `absence` argument decides, never the side: every side is asked both ways.
  describe.each(FS_SIDES)('a present entry whose probe answers ENOENT, on side %s', (side) => {
    it.each(['entry', 'follow'] as const)('is refused when the absence must be confirmed (%s): the parent lists it', (name) => {
      const file = presentFileProbedAbsent();
      const mode: PresenceMode = name === 'entry' ? 'entry' : { follow: scratch() };
      expect(() => pathPresent(file, mode, everywhere(side), 'confirmed')).toThrow(
        expect.objectContaining({ code: FS_FAULT_CODE, side, errno: 'ENOENT', path: file }),
      );
    });

    it('is absent when the probe is taken at its word, and nothing is listed', () => {
      const file = presentFileProbedAbsent();
      expect(pathPresent(file, { follow: scratch() }, everywhere(side), 'probe')).toBe(false);
      expect(session?.calls.filter((call) => call.family === 'list')).toEqual([]);
    });
  });

  // A fault is charged to the side of the path the OS refused: a followed probe walks each component beneath
  // its tree, and one it may not examine is refused on THAT component's side, never the probed input's.
  it('charges a refused walk component to its own side, not the probed path\'s', () => {
    const dist = safePath.join(scratch(), 'dist');
    const input = safePath.join(dist, 'skills');
    mkdirSyncReal(input, { recursive: true });
    session = installFaultFs({ within: scratch(), faults: [{ family: 'meta', op: 'lstat', path: (p) => p === dist, errno: 'EACCES' }] });
    expect(() => pathPresent(input, { follow: scratch() }, sideWithin(input, 'source', 'destination'), 'probe')).toThrow(
      expect.objectContaining({ code: FS_FAULT_CODE, side: 'destination', errno: 'EACCES', path: dist }),
    );
  });

  it('charges a refused confirming listing to the listed parent\'s side', () => {
    const missing = safePath.join(scratch(), 'config.yaml');
    session = installFaultFs({ within: scratch(), faults: [{ family: 'list', path: (p) => p === scratch(), errno: 'EPERM' }] });
    expect(() => pathPresent(missing, { follow: scratch() }, sideWithin(missing, 'source', 'destination'), 'confirmed')).toThrow(
      expect.objectContaining({ code: FS_FAULT_CODE, side: 'destination', errno: 'EPERM' }),
    );
  });

  // chmod 000 does not restrict access on Windows, and root bypasses permission checks.
  it.skipIf(CANNOT_DENY_READS)('refuses a path under a directory it may not search, on the caller\'s side', () => {
    const locked = safePath.join(scratch(), 'locked');
    mkdirSyncReal(locked);
    const inside = safePath.join(locked, 'manifest.json');
    writeFileSync(inside, '{}');
    chmodSync(locked, 0o000);
    try {
      expect(() => pathPresent(inside, { follow: scratch() }, everywhere('destination'), 'probe')).toThrow(
        expect.objectContaining({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused', errno: 'EACCES', path: inside }),
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
