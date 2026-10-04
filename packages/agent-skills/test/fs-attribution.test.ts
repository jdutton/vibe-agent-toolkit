/**
 * `withFsAttribution` is the packager's ONE attribution point for a filesystem
 * refusal, and what it throws is coded by the SIDE that refused: the skill's own
 * source is the packaging-input refusal every lane's `isSkillPackagingInputError`
 * dispatch recognises; the build's output is an unfinished run, which that
 * predicate must not match. Uncoded, each lane publishes either as a defect in VAT.
 */

import { isVatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { READ_REMEDY, withFsAttribution, type FsSide } from '../src/fs-attribution.js';
import { isSkillPackagingInputError, SKILL_PACKAGING_OUTPUT_FAILED_CODE } from '../src/packaging-errors.js';

/** An error shaped as node raises a filesystem refusal. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused, open 'payload.bin'`), { code, syscall: 'open', path: 'payload.bin' });
}

async function thrownBy(side: FsSide, work: () => Promise<never>, action?: string): Promise<unknown> {
  try {
    await withFsAttribution("files: entry 'payload.bin'", side, work, action);
  } catch (error) {
    return error;
  }
  throw new Error('withFsAttribution did not throw');
}

describe('withFsAttribution', () => {
  it.each(['EACCES', 'EPERM', 'EISDIR'])('codes a %s refusal of the SOURCE as the packaging-input refusal every lane dispatches on', async (code) => {
    const refused = errnoError(code);

    const thrown = await thrownBy('source', () => Promise.reject(refused));

    expect(isSkillPackagingInputError(thrown)).toBe(true);
    expect((thrown as Error).cause).toBe(refused);
  });

  // A full disk or an unwritable output directory says nothing about the skill's content.
  it.each(['EACCES', 'EPERM', 'ENOSPC', 'EROFS'])('codes a %s refusal of the OUTPUT as an unfinished run, never as the skill\'s content', async (code) => {
    const refused = errnoError(code);

    const thrown = await thrownBy('output', () => Promise.reject(refused));

    expect(isVatError(thrown, SKILL_PACKAGING_OUTPUT_FAILED_CODE), String(thrown)).toBe(true);
    expect(isSkillPackagingInputError(thrown)).toBe(false);
    expect((thrown as Error).cause).toBe(refused);
  });

  // Two `files:` dests where one lands under the other's FILE: the bundle layout the
  // skill's config asked for cannot exist. That is the skill's, on whichever side it surfaces.
  it.each(['EEXIST', 'ENOTDIR', 'EISDIR'])('codes a %s on the OUTPUT as the skill\'s content: the config laid out a bundle that cannot exist', async (code) => {
    const thrown = await thrownBy('output', () => Promise.reject(errnoError(code)));

    expect(isSkillPackagingInputError(thrown), String(thrown)).toBe(true);
  });

  it('keeps the subject, the action, the errno text and the side\'s remedy in the message', async () => {
    const read = await thrownBy('source', () => Promise.reject(errnoError('EACCES')), 'read');
    const written = await thrownBy('output', () => Promise.reject(errnoError('EACCES')));

    expect((read as Error).message).toBe(
      `files: entry 'payload.bin', but it could not be read: EACCES: refused, open 'payload.bin'. ${READ_REMEDY}`,
    );
    // The output side's remedy is about the output: the directory, and the space on the device.
    expect((written as Error).message).toMatch(
      /^files: entry 'payload\.bin', but it could not be copied into the bundle: EACCES: refused, open 'payload\.bin'\. .*output directory is writable.*space on the device\.$/,
    );
  });

  it.each(['source', 'output'] as const)('rethrows a non-filesystem throw on the %s side untouched: a defect is never worded as the adopter\'s', async (side) => {
    const defect = new TypeError("Cannot read properties of undefined (reading 'length')");

    const thrown = await thrownBy(side, () => Promise.reject(defect));

    expect(thrown).toBe(defect);
  });

  it('returns what the work returns when nothing is refused', async () => {
    await expect(withFsAttribution('a skill', 'source', () => Promise.resolve(7))).resolves.toBe(7);
  });
});
