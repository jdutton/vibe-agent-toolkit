import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '../../src/validators/types.js';
import { runValidationFramework } from '../../src/validators/validation-framework.js';

const issue = (code: string, location: string, severity: 'error' | 'warning' = 'error'): ValidationIssue => ({
  severity, code: code as ValidationIssue['code'], message: `${code}`, location,
});

describe('runValidationFramework', () => {
  it('drops ignored codes before emission', () => {
    const result = runValidationFramework(
      [issue('LINK_DROPPED_BY_DEPTH', 'a.md', 'warning')],
      { severity: { LINK_DROPPED_BY_DEPTH: 'ignore' } },
    );
    expect(result.emitted).toHaveLength(0);
  });

  it('re-stamps severity from config onto emitted issues', () => {
    const result = runValidationFramework(
      [issue('LINK_DROPPED_BY_DEPTH', 'a.md', 'warning')],
      { severity: { LINK_DROPPED_BY_DEPTH: 'error' } },
    );
    expect(result.emitted).toHaveLength(1);
    const [first] = result.emitted;
    expect(first?.severity).toBe('error');
  });

  it('emits ACCEPTANCE_EXPIRED at resolved severity when accept entry is past expires', () => {
    const result = runValidationFramework(
      [issue('LINK_DROPPED_BY_DEPTH', 'docs/foo.md', 'warning')],
      {
        accept: {
          LINK_DROPPED_BY_DEPTH: [{ paths: ['docs/foo.md'], reason: 'x', expires: '2020-01-01' }],
        },
      },
    );
    const meta = result.emitted.filter(i => i.code === 'ACCEPTANCE_EXPIRED');
    expect(meta).toHaveLength(1);
    const [first] = meta;
    expect(first?.severity).toBe('warning');
  });

  it('emits ACCEPTANCE_UNUSED when no issue matched an entry', () => {
    const result = runValidationFramework([], {
      accept: { LINK_DROPPED_BY_DEPTH: [{ paths: ['never-matches/**'], reason: 'dead' }] },
    });
    const meta = result.emitted.filter(i => i.code === 'ACCEPTANCE_UNUSED');
    expect(meta).toHaveLength(1);
  });

  it('respects severity override on meta-codes (error promotion)', () => {
    const result = runValidationFramework([], {
      accept: { LINK_DROPPED_BY_DEPTH: [{ paths: ['x/**'], reason: 'dead' }] },
      severity: { ACCEPTANCE_UNUSED: 'error' },
    });
    const meta = result.emitted.find(i => i.code === 'ACCEPTANCE_UNUSED');
    expect(meta?.severity).toBe('error');
  });

  it('reports hasErrors true when any emitted issue is an error', () => {
    const result = runValidationFramework(
      [issue('LINK_OUTSIDE_PROJECT', 'x.md', 'error')],
      {},
    );
    expect(result.hasErrors).toBe(true);
  });
});
