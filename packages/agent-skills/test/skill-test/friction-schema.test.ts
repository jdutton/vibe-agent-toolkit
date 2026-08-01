import { describe, expect, it } from 'vitest';

import { FrictionReportSchema } from '../../src/skill-test/friction-schema.js';

describe('FrictionReportSchema', () => {
  it('accepts a valid report', () => {
    const r = FrictionReportSchema.parse({
      items: [
        { severity: 'high', category: 'path-assumption', message: 'cwd-relative script path' },
        {
          severity: 'medium',
          category: 'undeclared-dependency',
          message: 'needs sibling skill foo',
          subjectFile: 'scripts/run.py',
          evidence: 'imported ../foo',
        },
      ],
    });
    expect(r.items).toHaveLength(2);
  });

  it('accepts the tool-expectation category (Phase T)', () => {
    const r = FrictionReportSchema.parse({
      items: [{ severity: 'medium', category: 'tool-expectation', message: 'declared mustRun `csvsum` never ran' }],
    });
    expect(r.items[0]?.category).toBe('tool-expectation');
  });

  it('rejects an unknown category', () => {
    expect(() =>
      FrictionReportSchema.parse({ items: [{ severity: 'high', category: 'bogus', message: 'x' }] }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => FrictionReportSchema.parse({ items: [], extra: 1 })).toThrow();
  });

  it('rejects unknown item keys (strict)', () => {
    expect(() =>
      FrictionReportSchema.parse({ items: [{ severity: 'low', category: 'ambient-propping', message: 'x', oops: 1 }] }),
    ).toThrow();
  });
});
