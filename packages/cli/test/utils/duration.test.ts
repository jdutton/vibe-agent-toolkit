import { describe, expect, it } from 'vitest';

import { roundToSigFigs, formatDurationSecs } from '../../src/utils/duration.js';

// ⚠️ `toBeCloseTo(x, 10)` here is an EXACTNESS assertion, not a tolerance. These
// functions round to 3 significant figures, so the nearest wrong answer differs
// in the 3rd sig fig — orders of magnitude above a 5e-11 window. Loosening the
// precision (e.g. to 2 or 3) would let `0.00123` pass as `0`, which is the exact
// bug the sub-millisecond cases below exist to catch.
describe('roundToSigFigs', () => {
  it('should round 0.351234 to 3 sig figs as 0.351', () => {
    expect(roundToSigFigs(0.351234, 3)).toBeCloseTo(0.351, 10);
  });

  it('should handle zero', () => {
    expect(roundToSigFigs(0, 3)).toBe(0);
  });

  it('should round 1234.567 to 3 sig figs as 1230', () => {
    expect(roundToSigFigs(1234.567, 3)).toBeCloseTo(1230, 10);
  });

  it('should round 0.00123456 to 3 sig figs as 0.00123', () => {
    expect(roundToSigFigs(0.00123456, 3)).toBeCloseTo(0.00123, 10);
  });
});

describe('formatDurationSecs', () => {
  it('should convert ms to seconds with 3 sig figs', () => {
    expect(formatDurationSecs(351)).toBeCloseTo(0.351, 10);
  });

  it('should convert 15ms to 0.015 seconds', () => {
    expect(formatDurationSecs(15)).toBeCloseTo(0.015, 10);
  });

  it('should convert 1234ms to 1.23 seconds', () => {
    expect(formatDurationSecs(1234)).toBeCloseTo(1.23, 10);
  });
});
