/**
 * Which refusal a `.zip` that could not be extracted is: the disk VAT stages on
 * giving out is the run not finishing; anything else is the archive's.
 */

import { describe, expect, it } from 'vitest';

import { zipExtractionRefusal } from '../../../../src/commands/claude/plugin/install.js';

const ZIP = '/src/skill.zip';
const STAGED = '/tmp/vat-install-zip-x/skill';

/** An errno-shaped error. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code });
}

describe('zipExtractionRefusal', () => {
  it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'])('codes %s while staging as RUN_INCOMPLETE, naming the staging path', (code) => {
    const refusal = zipExtractionRefusal(ZIP, STAGED, errnoError(code));

    expect(refusal.refusal).toBe('RUN_INCOMPLETE');
    expect(refusal.message).toContain(STAGED);
    expect(refusal.message).not.toContain(ZIP);
  });

  it.each([
    ['a file `a` beside a file `a/b`', errnoError('ENOTDIR')],
    ['an entry that already exists as a directory', errnoError('EISDIR')],
    ['an error of the archive library itself', new Error('Invalid or unsupported zip format')],
  ])('codes %s as the archive\'s INPUT_UNREADABLE, naming the archive', (_label, error) => {
    const refusal = zipExtractionRefusal(ZIP, STAGED, error);

    expect(refusal.refusal).toBe('INPUT_UNREADABLE');
    expect(refusal.message).toContain(ZIP);
  });
});
