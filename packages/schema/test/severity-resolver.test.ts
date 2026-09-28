import { describe, expect, it } from 'vitest';

import { resolveSeverity } from '../src/validation-framework.js';

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

describe('resolveSeverity — code kinds', () => {
  it('resolves a refusal to its registry default, whatever an (unparsed) config says', () => {
    // The config schema refuses a refusal key; this is the second wall, for a
    // config object that never went through the schema.
    const cfg = { severity: { RESOURCE_CHECK_BROKEN: 'ignore' } } as unknown as Parameters<typeof resolveSeverity>[1];
    expect(resolveSeverity('RESOURCE_CHECK_BROKEN', cfg)).toBe('error');
  });

  it('still resolves a CUSTOM: check code to its override — a non-registry code is not a refusal', () => {
    // `resolveIssueSeverity` in the CLI hands a `CUSTOM:` code here once it has
    // found its override. Deciding "overridable" by looking up the registry
    // entry's kind threw on it.
    const code = 'CUSTOM:my-check' as unknown as Parameters<typeof resolveSeverity>[0];
    expect(resolveSeverity(code, { severity: { 'CUSTOM:my-check': 'warning' } })).toBe('warning');
  });
});
