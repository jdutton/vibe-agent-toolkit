/**
 * Which refusal an archive (`.zip`, `.tgz`, an npm tarball) that could not be
 * extracted is: the disk VAT stages on giving out is the run not finishing;
 * anything else is the archive's.
 */

import { describe, expect, it } from 'vitest';

import { archiveExtractionRefusal } from '../../src/utils/archive-staging.js';

const ARCHIVE = '/src/skill.tgz';
const STAGED = '/tmp/vat-install-tgz-x';

/** An errno-shaped error — node-tar's entry failures carry the errno as `code` and its own as `tarCode`. */
function errnoError(code: string, tarCode?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code }, tarCode === undefined ? {} : { tarCode });
}

describe('archiveExtractionRefusal', () => {
  it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'])('codes %s while staging as RUN_INCOMPLETE, naming the staging path', (code) => {
    const refusal = archiveExtractionRefusal(ARCHIVE, STAGED, errnoError(code, 'TAR_ENTRY_ERROR'));

    expect(refusal.refusal).toBe('RUN_INCOMPLETE');
    expect(refusal.message).toContain(STAGED);
    expect(refusal.message).not.toContain(ARCHIVE);
  });

  it.each([
    ['a file `a` beside a file `a/b` (adm-zip)', errnoError('ENOTDIR')],
    ['a file `a` beside a file `a/b` (node-tar)', errnoError('EEXIST', 'TAR_ENTRY_ERROR')],
    ['an entry that already exists as a directory', errnoError('EISDIR')],
    ['bytes that are no tarball', errnoError('TAR_BAD_ARCHIVE', 'TAR_BAD_ARCHIVE')],
    ['an error of the archive library itself', new Error('Invalid or unsupported zip format')],
  ])('codes %s as the archive\'s INPUT_UNREADABLE, naming the archive', (_label, error) => {
    const refusal = archiveExtractionRefusal(ARCHIVE, STAGED, error);

    expect(refusal.refusal).toBe('INPUT_UNREADABLE');
    expect(refusal.message).toContain(ARCHIVE);
  });
});
