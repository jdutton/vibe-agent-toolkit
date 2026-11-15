import { describe, expect, it } from 'vitest';

import { resolveFindings, resolveSeverity } from '../src/validation-framework.js';
import type { ValidationIssue } from '../src/validation-issue.js';

describe('resolveFindings — the one finding resolver', () => {
  const custom = { severity: 'error', code: 'CUSTOM:my-check', message: 'm', location: 'docs/a.md' } as unknown as ValidationIssue;
  const customConfig = (level: string): Parameters<typeof resolveFindings>[1] =>
    ({ severity: { 'CUSTOM:my-check': level } }) as unknown as Parameters<typeof resolveFindings>[1];

  it("applies a CUSTOM: check code's override, and ignore drops it", () => {
    expect(resolveFindings([custom], customConfig('warning'))).toStrictEqual([{ ...custom, severity: 'warning' }]);
    expect(resolveFindings([custom], customConfig('ignore'))).toStrictEqual([]);
  });

  it('passes a CUSTOM: check code with no override through as it is', () => {
    expect(resolveFindings([custom], {})).toStrictEqual([custom]);
  });

  it('never demotes an unregistered code that is not a CUSTOM: check — a lane refusal passes through', () => {
    const refusal = { severity: 'error', code: 'SKILL_MISSING_FRONTMATTER', message: 'm', location: 'SKILL.md' } as unknown as ValidationIssue;
    const config = { severity: { SKILL_MISSING_FRONTMATTER: 'ignore' } } as unknown as Parameters<typeof resolveFindings>[1];
    expect(resolveFindings([refusal], config)).toStrictEqual([refusal]);
  });

  it('reads the allow list before severity', () => {
    const refused: ValidationIssue = { severity: 'error', code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', message: 'm', location: 'docs/deep.md' };
    const config: Parameters<typeof resolveFindings>[1] = {
      severity: { RESOURCE_PARSE_LIMIT_EXCEEDED: 'error' },
      allow: { RESOURCE_PARSE_LIMIT_EXCEEDED: [{ paths: ['docs/deep.md'], reason: 'seeded' }] },
    };
    expect(resolveFindings([refused], config)).toStrictEqual([]);
  });
});

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
    // `resolveFindings` in the CLI hands a `CUSTOM:` code here once it has
    // found its override. Deciding "overridable" by looking up the registry
    // entry's kind threw on it.
    const code = 'CUSTOM:my-check' as unknown as Parameters<typeof resolveSeverity>[0];
    expect(resolveSeverity(code, { severity: { 'CUSTOM:my-check': 'warning' } })).toBe('warning');
  });
});
