import { describe, expect, it } from 'vitest';

import {
  allowUnusedIssues,
  createAllowUsageLedger,
  runValidationFramework,
} from '../src/validation-framework.js';
import type { ValidationIssue } from '../src/validation-issue.js';

const issue = (code: string, location: string, severity: 'error' | 'warning' = 'error'): ValidationIssue => ({
  severity, code: code as ValidationIssue['code'], message: `${code}`, location,
});

/**
 * Single-unit runs, spelled out with an explicit ledger rather than via
 * `runSingleUnitValidation`, so these cases keep exercising the framework
 * function itself. Run-level ALLOW_UNUSED is drained where each case asserts it.
 */
describe('runValidationFramework', () => {
  it('drops ignored codes before emission', () => {
    const result = runValidationFramework(
      [issue('LINK_DROPPED_BY_DEPTH', 'a.md', 'warning')],
      { severity: { LINK_DROPPED_BY_DEPTH: 'ignore' } },
      createAllowUsageLedger(),
    );
    expect(result.emitted).toHaveLength(0);
  });

  it('re-stamps severity from config onto emitted issues', () => {
    const result = runValidationFramework(
      [issue('LINK_DROPPED_BY_DEPTH', 'a.md', 'warning')],
      { severity: { LINK_DROPPED_BY_DEPTH: 'error' } },
      createAllowUsageLedger(),
    );
    expect(result.emitted).toHaveLength(1);
    const [first] = result.emitted;
    expect(first?.severity).toBe('error');
  });

  it('emits ALLOW_EXPIRED at resolved severity when allow entry is past expires', () => {
    const result = runValidationFramework(
      [issue('LINK_DROPPED_BY_DEPTH', 'docs/foo.md', 'warning')],
      {
        allow: {
          LINK_DROPPED_BY_DEPTH: [{ paths: ['docs/foo.md'], reason: 'x', expires: '2020-01-01' }],
        },
      },
      createAllowUsageLedger(),
    );
    const meta = result.emitted.filter(i => i.code === 'ALLOW_EXPIRED');
    expect(meta).toHaveLength(1);
    const [first] = meta;
    expect(first?.severity).toBe('warning');
  });

  it('emits ALLOW_UNUSED when no issue in the run matched an entry', () => {
    const ledger = createAllowUsageLedger();
    runValidationFramework([], {
      allow: { LINK_DROPPED_BY_DEPTH: [{ paths: ['never-matches/**'], reason: 'dead' }] },
    }, ledger);
    const meta = allowUnusedIssues(ledger).filter(i => i.code === 'ALLOW_UNUSED');
    expect(meta).toHaveLength(1);
  });

  it('respects severity override on meta-codes (error promotion)', () => {
    const ledger = createAllowUsageLedger();
    runValidationFramework([], {
      allow: { LINK_DROPPED_BY_DEPTH: [{ paths: ['x/**'], reason: 'dead' }] },
      severity: { ALLOW_UNUSED: 'error' },
    }, ledger);
    const meta = allowUnusedIssues(ledger).find(i => i.code === 'ALLOW_UNUSED');
    expect(meta?.severity).toBe('error');
  });

  it('reports hasErrors true when any emitted issue is an error', () => {
    const result = runValidationFramework(
      [issue('LINK_OUTSIDE_PROJECT', 'x.md', 'error')],
      {},
      createAllowUsageLedger(),
    );
    expect(result.hasErrors).toBe(true);
  });
});
