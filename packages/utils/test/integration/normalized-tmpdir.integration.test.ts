/**
 * `normalizedTmpdir()` when the OS refuses to resolve $TMPDIR. Every verb roots its
 * scratch, staging and caches there, so a raw errno here ended the verb in
 * INTERNAL_ERROR. It is VAT's scratch space failing: an `environment` fault.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safePath } from '../../src/path-core.js';
import { normalizedTmpdir } from '../../src/path-utils.js';
import { installFaultFs, type FaultFsSession } from '../../src/testing/fault-fs.js';
import type { InjectedErrno } from '../../src/testing/fault-spec.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';

const scratch = tempDirTracker('normalized-tmpdir-');
let session: FaultFsSession | undefined;
/** The temp directory under test: a scratch dir the environment names, so the fault touches nothing shared. */
let tmp = '';
beforeEach(() => {
  tmp = safePath.resolve(scratch.create());
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, tmp);
});
afterEach(() => {
  session?.restore();
  session = undefined;
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

describe('normalizedTmpdir', () => {
  it.each([['EACCES', 'refused'], ['EPERM', 'refused']] as const)('raises a refused realpath of $TMPDIR (%s) as an environment fault', (errno: InjectedErrno, faultClass) => {
    session = installFaultFs({ within: tmp, faults: [{ family: 'meta', op: 'realpath', path: (p) => p === tmp, errno }] });
    expect(() => normalizedTmpdir()).toThrow(expect.objectContaining({ code: 'FS_FAULT', side: 'environment', faultClass, errno }));
    expect(session.fired).toHaveLength(1);
  });

  it('still answers the real path when nothing refuses', () => {
    session = installFaultFs({ within: tmp });
    expect(safePath.resolve(normalizedTmpdir())).toBe(tmp);
  });
});
