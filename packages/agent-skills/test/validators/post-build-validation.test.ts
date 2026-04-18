import { describe, it, expect } from 'vitest';

import { SOURCE_ONLY_CODES } from '../../src/validators/source-only-codes.js';

describe('SOURCE_ONLY_CODES', () => {
  it('contains LINK_OUTSIDE_PROJECT', () => {
    expect(SOURCE_ONLY_CODES.has('LINK_OUTSIDE_PROJECT')).toBe(true);
  });

  it('contains LINK_BOUNDARY_VIOLATION', () => {
    expect(SOURCE_ONLY_CODES.has('LINK_BOUNDARY_VIOLATION')).toBe(true);
  });

  it('does NOT contain codes that apply to built output', () => {
    expect(SOURCE_ONLY_CODES.has('DESCRIPTION_TOO_VAGUE')).toBe(false);
    expect(SOURCE_ONLY_CODES.has('SKILL_LENGTH_EXCEEDS_RECOMMENDED')).toBe(false);
    expect(SOURCE_ONLY_CODES.has('PACKAGED_BROKEN_LINK')).toBe(false);
  });
});
