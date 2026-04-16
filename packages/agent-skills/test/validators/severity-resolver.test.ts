import { describe, expect, it } from 'vitest';

import { resolveSeverity } from '../../src/validators/severity-resolver.js';

describe('resolveSeverity', () => {
  it('returns registry default when no override', () => {
    expect(resolveSeverity('LINK_OUTSIDE_PROJECT', {})).toBe('error');
    expect(resolveSeverity('LINK_DROPPED_BY_DEPTH', {})).toBe('warning');
  });
  it('applies code-level severity override', () => {
    expect(resolveSeverity('LINK_DROPPED_BY_DEPTH', { severity: { LINK_DROPPED_BY_DEPTH: 'error' } })).toBe('error');
    expect(resolveSeverity('LINK_OUTSIDE_PROJECT', { severity: { LINK_OUTSIDE_PROJECT: 'ignore' } })).toBe('ignore');
  });
  it('ignores unknown codes gracefully (returns default for the known code)', () => {
    // TypeScript prevents unknown codes, but runtime input from YAML may include junk
    const cfg = { severity: { NOT_A_REAL_CODE: 'error' } } as unknown as Parameters<typeof resolveSeverity>[1];
    expect(resolveSeverity('LINK_OUTSIDE_PROJECT', cfg)).toBe('error');
  });
});
