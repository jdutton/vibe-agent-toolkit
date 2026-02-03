import { describe, expect, it } from 'vitest';

import { roundToSigFigs, formatDurationSecs } from '../../src/utils/duration.js';

describe('roundToSigFigs', () => {
  it('should round 0.351234 to 3 sig figs as 0.351', () => {
    expect(roundToSigFigs(0.351234, 3)).toBe(0.351);
  });

  it('should handle zero', () => {
    expect(roundToSigFigs(0, 3)).toBe(0);
  });

  it('should round 1234.567 to 3 sig figs as 1230', () => {
    expect(roundToSigFigs(1234.567, 3)).toBe(1230);
  });

  it('should round 0.00123456 to 3 sig figs as 0.00123', () => {
    expect(roundToSigFigs(0.00123456, 3)).toBe(0.00123);
  });
});

describe('formatDurationSecs', () => {
  it('should convert ms to seconds with 3 sig figs', () => {
    expect(formatDurationSecs(351)).toBe(0.351);
  });

  it('should convert 15ms to 0.015 seconds', () => {
    expect(formatDurationSecs(15)).toBe(0.015);
  });

  it('should convert 1234ms to 1.23 seconds', () => {
    expect(formatDurationSecs(1234)).toBe(1.23);
  });
});
