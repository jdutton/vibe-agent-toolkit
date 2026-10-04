/**
 * `withFsAttribution` is the packager's ONE attribution point for a filesystem
 * refusal, and what it throws is addressed to the adopter with a remedy — so it
 * is a coded packaging refusal, the thing every packaging lane's
 * `isSkillPackagingInputError` dispatch recognises. Uncoded, each lane publishes
 * "check the file's permissions" as a defect in VAT.
 */

import { describe, expect, it } from 'vitest';

import { READ_REMEDY, withFsAttribution } from '../src/fs-attribution.js';
import { isSkillPackagingInputError } from '../src/packaging-errors.js';

/** An error shaped as node raises a filesystem refusal. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused, open 'payload.bin'`), { code, syscall: 'open', path: 'payload.bin' });
}

async function thrownBy(work: () => Promise<never>, action?: string, remedy?: string): Promise<unknown> {
  try {
    await withFsAttribution("files: entry 'payload.bin'", work, action, remedy);
  } catch (error) {
    return error;
  }
  throw new Error('withFsAttribution did not throw');
}

describe('withFsAttribution', () => {
  it.each(['EACCES', 'EPERM', 'ENOSPC'])('codes a %s refusal as the packaging-input refusal every lane dispatches on', async (code) => {
    const refused = errnoError(code);

    const thrown = await thrownBy(() => Promise.reject(refused));

    expect(isSkillPackagingInputError(thrown)).toBe(true);
    expect((thrown as Error).cause).toBe(refused);
  });

  it('keeps the subject, the action, the errno text and the remedy in the message', async () => {
    const thrown = await thrownBy(() => Promise.reject(errnoError('EACCES')), 'read', READ_REMEDY);

    expect((thrown as Error).message).toBe(
      `files: entry 'payload.bin', but it could not be read: EACCES: refused, open 'payload.bin'. ${READ_REMEDY}`,
    );
  });

  it('rethrows a non-filesystem throw untouched: a defect is never worded as the adopter\'s', async () => {
    const defect = new TypeError("Cannot read properties of undefined (reading 'length')");

    const thrown = await thrownBy(() => Promise.reject(defect));

    expect(thrown).toBe(defect);
    expect(isSkillPackagingInputError(thrown)).toBe(false);
  });

  it('returns what the work returns when nothing is refused', async () => {
    await expect(withFsAttribution('a skill', () => Promise.resolve(7))).resolves.toBe(7);
  });
});
