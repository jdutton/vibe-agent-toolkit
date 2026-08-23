import { describe, expect, it } from 'vitest';

import { compareCodeUnits } from '../src/compare-code-units.js';

describe('compareCodeUnits', () => {
  it('orders by code unit and reports equality as 0', () => {
    expect(compareCodeUnits('a', 'b')).toBeLessThan(0);
    expect(compareCodeUnits('b', 'a')).toBeGreaterThan(0);
    expect(compareCodeUnits('a', 'a')).toBe(0);
  });

  it('is a total order: sorting is stable and reversible', () => {
    const input = ['b', 'A', 'a', 'B', '1', 'ä'];
    const forward = [...input].sort(compareCodeUnits);
    const fromReversed = [...input].reverse().sort(compareCodeUnits);
    expect(fromReversed).toEqual(forward);
  });

  it('sorts uppercase before lowercase — the property that distinguishes it from a collator', () => {
    // `'Z' < 'a'` by code unit, but a locale collator groups case-insensitively and puts `a`
    // first. If this ever flips, someone has substituted `localeCompare` and every digest,
    // content key and serialized document has become host-dependent.
    expect(compareCodeUnits('Z', 'a')).toBeLessThan(0);
    expect('Z'.localeCompare('a')).toBeGreaterThan(0);
  });

  it('does not fold accents the way a collator does', () => {
    // Under most locales `localeCompare` places `ä` adjacent to `a`; by code unit it sorts
    // after every ASCII letter. Two machines with different default locales would disagree.
    expect(compareCodeUnits('ä', 'z')).toBeGreaterThan(0);
    expect('ä'.localeCompare('z')).toBeLessThan(0);
  });
});
