/**
 * The one severity vocabulary, the one finding, the one report envelope.
 *
 * What these pin: the envelope cannot be built without a denominator, its
 * status is a literal statement about its own findings list, an ignored issue
 * never reaches a report, and the schema refuses an envelope key nobody
 * declared — because the emitted `schemas/<command>.json` is what an adopter's
 * `jq` recipe is written against.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildReport,
  compareSeverity,
  FindingSchema,
  IssueSeveritySchema,
  REPORT_ENVELOPE_KEYS,
  reportSchema,
  SEVERITIES,
  SeveritySchema,
  strongerSeverity,
  toFindings,
  type Finding,
  type ValidationIssue,
} from '../src/index.js';

function finding(severity: Finding['severity'], location = 'docs/a.md'): Finding {
  return { code: 'LINK_MISSING_TARGET', severity, message: `a ${severity}`, location };
}

describe('Severity', () => {
  it('is exactly error, warning, info — and the issue vocabulary is that plus ignore', () => {
    expect([...SEVERITIES]).toEqual(['error', 'warning', 'info']);
    expect(SeveritySchema.options).toEqual(['error', 'warning', 'info']);
    expect(IssueSeveritySchema.options).toEqual(['error', 'warning', 'info', 'ignore']);
  });

  it('rejects the spellings the collapsed vocabularies used', () => {
    for (const spelling of ['warn', 'high', 'fail', 'ignore']) {
      expect(SeveritySchema.safeParse(spelling).success).toBe(false);
    }
  });

  it('orders strongest first and never grades downward', () => {
    expect(compareSeverity('error', 'info')).toBeLessThan(0);
    expect(compareSeverity('info', 'warning')).toBeGreaterThan(0);
    expect(compareSeverity('warning', 'warning')).toBe(0);
    expect(strongerSeverity('warning', 'info')).toBe('warning');
    expect(strongerSeverity('info', 'error')).toBe('error');
    // The property that matters: the result is never weaker than either input.
    for (const a of SEVERITIES) {
      for (const b of SEVERITIES) {
        const stronger = strongerSeverity(a, b);
        expect(compareSeverity(stronger, a)).toBeLessThanOrEqual(0);
        expect(compareSeverity(stronger, b)).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe('FindingSchema', () => {
  it('is a ValidationIssue without ignore, plus column', () => {
    expect(FindingSchema.safeParse(finding('warning')).success).toBe(true);
    expect(FindingSchema.safeParse({ ...finding('info'), line: 3, column: 7 }).success).toBe(true);
    expect(FindingSchema.safeParse({ ...finding('info'), severity: 'ignore' }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding('info'), column: 0 }).success).toBe(false);
  });

  it('keeps the anchor contract: an absolute location is refused', () => {
    expect(FindingSchema.safeParse(finding('error', '/Users/dev/docs/a.md')).success).toBe(false);
  });

  it('is strict — the five names for "the file" cannot creep back in', () => {
    for (const alias of ['file', 'path', 'document', 'source']) {
      expect(FindingSchema.safeParse({ ...finding('error'), [alias]: 'x' }).success).toBe(false);
    }
  });
});

describe('toFindings', () => {
  it('drops ignored issues and keeps every other severity in order', () => {
    const issues: ValidationIssue[] = [
      { code: 'LINK_MISSING_TARGET', severity: 'info', message: 'i' },
      { code: 'LINK_MISSING_TARGET', severity: 'ignore', message: 'silenced' },
      { code: 'LINK_MISSING_TARGET', severity: 'error', message: 'e' },
    ];
    expect(toFindings(issues).map((f) => f.severity)).toEqual(['info', 'error']);
  });
});

describe('buildReport', () => {
  it('says ok with a denominator when nothing was found', () => {
    const report = buildReport({ examined: 12, findings: [], data: { root: '.' } });
    expect(report).toEqual({
      status: 'ok',
      examined: 12,
      findings: [],
      summary: { errors: 0, warnings: 0, info: 0 },
      data: { root: '.' },
    });
  });

  it('derives status and summary from the findings it was given', () => {
    const report = buildReport({
      examined: 3,
      findings: [finding('info'), finding('error'), finding('warning'), finding('error')],
      data: undefined,
      durationMs: 42,
    });
    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 2, warnings: 1, info: 1 });
    expect(report.durationMs).toBe(42);
  });

  it('cannot be built without examined — the type requires it and the schema refuses its absence', () => {
    const schema = reportSchema(z.object({ root: z.string() }).strict());
    const report = buildReport({ examined: 0, findings: [], data: { root: '.' } });
    expect(schema.safeParse(report).success).toBe(true);
    const withoutExamined: Record<string, unknown> = { ...report };
    delete withoutExamined['examined'];
    expect(schema.safeParse(withoutExamined).success).toBe(false);
  });
});

describe('reportSchema', () => {
  const schema = reportSchema(z.object({ root: z.string() }).strict());

  it('carries every envelope key and refuses one nobody declared', () => {
    const shape = Object.keys(schema.shape);
    for (const key of REPORT_ENVELOPE_KEYS) expect(shape).toContain(key);
    const report = buildReport({ examined: 1, findings: [finding('error')], data: { root: '.' } });
    expect(schema.safeParse(report).success).toBe(true);
    expect(schema.safeParse({ ...report, issueCounts: report.summary }).success).toBe(false);
  });

  it('refuses a status that contradicts the findings vocabulary', () => {
    const report = buildReport({ examined: 1, findings: [], data: { root: '.' } });
    expect(schema.safeParse({ ...report, status: 'success' }).success).toBe(false);
    expect(schema.safeParse({ ...report, status: 'error', error: 'could not read root' }).success).toBe(true);
  });

  it('validates data through the schema it was given', () => {
    const report = buildReport({ examined: 1, findings: [], data: { root: 1 } });
    expect(schema.safeParse(report).success).toBe(false);
  });
});
