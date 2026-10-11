/**
 * `rootListingRefusal`: whether a failed `stat`/`readdir` of a scan root is an
 * absence (scanned and empty) or a refusal the caller must report.
 */

import { describe, expect, it } from 'vitest';

import { rootListingRefusal } from '../src/crawl.js';
import { safePath } from '../src/index.js';

/** Resolved, never a `/`-rooted literal: on Windows a driveless literal is not absolute. */
const ROOT = safePath.resolve('scan-root', 'plugins');

const errno = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

describe('rootListingRefusal', () => {
  it.each(['ENOENT', 'ENOTDIR'])('reads %s as absent: no refusal', (code) => {
    expect(rootListingRefusal(errno(code), ROOT)).toBeUndefined();
  });

  it('reads EACCES as a refusal of that directory, not transient', () => {
    expect(rootListingRefusal(errno('EACCES'), ROOT)).toStrictEqual({
      kind: 'directory_unreadable',
      code: 'EACCES',
      directory: ROOT,
      transient: false,
    });
  });

  it('reads an error with no errno as a refusal, never as absence', () => {
    expect(rootListingRefusal(new Error('no code'), ROOT)?.code).toBe('UNKNOWN');
  });
});
