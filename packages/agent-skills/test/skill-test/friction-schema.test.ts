import { describe, expect, it } from 'vitest';

import { FrictionReportJsonSchema, FrictionReportSchema } from '../../src/skill-test/friction-schema.js';

describe('FrictionReportSchema', () => {
  it('accepts a valid report', () => {
    const r = FrictionReportSchema.parse({
      items: [
        { severity: 'error', category: 'path-assumption', message: 'cwd-relative script path' },
        {
          severity: 'warning',
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
      items: [{ severity: 'warning', category: 'tool-expectation', message: 'declared mustRun `csvsum` never ran' }],
    });
    expect(r.items[0]?.category).toBe('tool-expectation');
  });

  it('rejects an unknown category', () => {
    expect(() =>
      FrictionReportSchema.parse({ items: [{ severity: 'error', category: 'bogus', message: 'x' }] }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => FrictionReportSchema.parse({ items: [], extra: 1 })).toThrow();
  });

  it('rejects unknown item keys (strict)', () => {
    expect(() =>
      FrictionReportSchema.parse({ items: [{ severity: 'info', category: 'ambient-propping', message: 'x', oops: 1 }] }),
    ).toThrow();
  });
});

describe('friction-report.json', () => {
  it('accepts only error|warning|info', () => {
    const severities = (FrictionReportJsonSchema as unknown as {
      definitions: { 'friction-report': { properties: { items: { items: { properties: { severity: { enum: string[] } } } } } } };
    }).definitions['friction-report'].properties.items.items.properties.severity.enum;
    expect(severities).toEqual(['error', 'warning', 'info']);
    for (const legacy of ['high', 'medium', 'low']) {
      expect(() =>
        FrictionReportSchema.parse({ items: [{ severity: legacy, category: 'path-assumption', message: 'x' }] }),
      ).toThrow();
    }
  });
});
