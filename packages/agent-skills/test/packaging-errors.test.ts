/**
 * `isSkillPackagingInputError` decides, in every packaging lane, whether a packager throw is the
 * `SKILL_PACKAGING_FAILED` finding about the skill or a refusal of the run. A classified fault on
 * the SOURCE side is the skill's — unless the machine ran out (`exhausted`) or was busy, which
 * says nothing about the skill. A destination or environment fault is never the skill's.
 */

import { classifyFsFault, VatError, type FsSide } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { asPackagerRefusal, isSkillPackagingInputError, packagingInputError, SKILL_NAME_NOT_A_SEGMENT_CODE, SKILL_PACKAGING_INPUT_INVALID_CODE } from '../src/packaging-errors.js';

/** A raw errno, classified on `side` the way the packager classifies it. */
function faultOn(side: FsSide, code: string): unknown {
  const raw = Object.assign(new Error(`${code}: injected, open '/p'`), { code, path: '/p' });
  return classifyFsFault(raw, { side, action: 'read the skill', origin: 'content' });
}

describe('isSkillPackagingInputError', () => {
  it('is a coded content refusal, or an unusable name', () => {
    expect(isSkillPackagingInputError(packagingInputError('a files: source is a directory'))).toBe(true);
    expect(isSkillPackagingInputError(new VatError(SKILL_NAME_NOT_A_SEGMENT_CODE, 'a/b'))).toBe(true);
  });

  it.each(['ENOENT', 'EACCES', 'EISDIR', 'EEXIST', 'EXDEV', 'EIO'])('is a %s fault on the source side: the skill is unreadable', (code) => {
    expect(isSkillPackagingInputError(faultOn('source', code))).toBe(true);
  });

  it.each(['ENOSPC', 'EMFILE', 'EBUSY'])('is not a %s fault on the source side: the machine ran out, the skill is fine', (code) => {
    expect(isSkillPackagingInputError(faultOn('source', code))).toBe(false);
  });

  it.each([
    ['destination', 'EACCES'],
    ['destination', 'ENOSPC'],
    ['environment', 'ENOENT'],
  ] as const)('is not a fault on the %s side (%s): the run did not finish', (side, code) => {
    expect(isSkillPackagingInputError(faultOn(side, code))).toBe(false);
  });

  it('is not a raw errno nor a defect: only a classified fault says which side refused', () => {
    expect(isSkillPackagingInputError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isSkillPackagingInputError(new TypeError('x is undefined'))).toBe(false);
  });
});

/**
 * A lane that reads sources of its own (`vat agent build`, `vat skill test run`) tells a source fault
 * raised INSIDE the packager from its own by marking it at the packager call: the packager's content
 * refusal, with the classified fault kept as its cause so the refusal table still sees it.
 */
describe('asPackagerRefusal', () => {
  it('marks a source fault from the packager as the packager\'s content refusal, keeping the fault', () => {
    const fault = faultOn('source', 'EACCES');
    const marked = asPackagerRefusal(fault);

    expect(marked).toMatchObject({ code: SKILL_PACKAGING_INPUT_INVALID_CODE, cause: fault });
    expect(isSkillPackagingInputError(marked)).toBe(true);
  });

  it.each([
    ['a capacity fault', faultOn('source', 'EMFILE')],
    ['a destination fault', faultOn('destination', 'EACCES')],
    ['a defect', new TypeError('x')],
  ] as const)('leaves %s as it was', (_what, thrown) => {
    expect(asPackagerRefusal(thrown)).toBe(thrown);
  });
});
