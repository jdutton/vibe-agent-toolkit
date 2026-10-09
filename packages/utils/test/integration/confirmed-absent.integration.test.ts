/**
 * `requireConfirmedAbsent`: a probe that answered "nothing there" is believed only
 * when the parent's listing agrees. A file whose probe the OS refused with `ENOENT`
 * while it IS there read as absent: a registry read as empty, a destination read as
 * free — and the write after it dropped what was there.
 */

import fs from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { requireConfirmedAbsent } from '../../src/errors/confirmed-absent.js';
import { FS_FAULT_CODE } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { createSymlinkAsync, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs, type FaultFsSession } from '../../src/testing/fault-fs.js';
import { injectedErrnoError } from '../../src/testing/fault-spec.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';

const scratch = tempDirTracker('confirmed-absent-');
let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
  scratch.cleanupAll();
});

const CTX = { side: 'destination', action: 'read the registry' } as const;
const FOLLOWS = { follows: true } as const;
const thrownBy = (run: () => void): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('requireConfirmedAbsent', () => {
  it('accepts an entry that is truly not there', () => {
    const root = scratch.create();
    const missing = safePath.join(root, 'missing.json');
    expect(thrownBy(() => requireConfirmedAbsent(missing, injectedErrnoError('ENOENT', 'open', missing), CTX, FOLLOWS))).toBeUndefined();
  });

  it('accepts an entry whose parent is not there either', () => {
    const root = scratch.create();
    const missing = safePath.join(root, 'no-dir', 'missing.json');
    expect(thrownBy(() => requireConfirmedAbsent(missing, injectedErrnoError('ENOTDIR', 'open', missing), CTX, FOLLOWS))).toBeUndefined();
  });

  it('refuses an entry its parent lists: the probe\'s own errno, classified on the caller\'s side, naming it', async () => {
    const root = scratch.create();
    const present = safePath.join(root, 'present.json');
    await fs.writeFile(present, '{}');
    expect(thrownBy(() => requireConfirmedAbsent(present, injectedErrnoError('ENOENT', 'open', present), CTX, FOLLOWS)))
      .toMatchObject({ code: FS_FAULT_CODE, side: 'destination', errno: 'ENOENT', path: present });
  });

  // A dotfiles link whose target is gone is "no file" to a read that follows it.
  it('accepts a dangling link its parent lists', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    const root = scratch.create();
    const link = safePath.join(root, 'settings.json');
    await createSymlinkAsync(cap, safePath.join(root, 'gone.json'), link);
    expect(thrownBy(() => requireConfirmedAbsent(link, injectedErrnoError('ENOENT', 'open', link), CTX, FOLLOWS))).toBeUndefined();
  });

  // An lstat sees the link itself: ENOENT from it on a link the parent lists is a fault, never "absent".
  it('refuses a listed link when the probe did not follow it (lstat)', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip('host cannot create symlinks');
    const root = scratch.create();
    const link = safePath.join(root, 'plugin');
    await createSymlinkAsync(cap, safePath.join(root, 'gone'), link);
    expect(thrownBy(() => requireConfirmedAbsent(link, injectedErrnoError('ENOENT', 'lstat', link), CTX, { follows: false })))
      .toMatchObject({ code: FS_FAULT_CODE, side: 'destination', errno: 'ENOENT', path: link });
  });

  it('refuses when the parent\'s listing is itself refused: absence was never shown', () => {
    const root = scratch.create();
    const missing = safePath.join(root, 'missing.json');
    session = installFaultFs({ within: root, faults: [{ family: 'list', path: (p) => p === root, errno: 'EACCES' }] });
    expect(thrownBy(() => requireConfirmedAbsent(missing, injectedErrnoError('ENOENT', 'open', missing), CTX, FOLLOWS)))
      .toMatchObject({ code: FS_FAULT_CODE, side: 'destination', errno: 'EACCES' });
  });
});
