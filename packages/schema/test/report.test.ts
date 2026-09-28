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
  buildErrorReport,
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

const LENIENT = { strict: false } as const;

describe('buildReport', () => {
  it('says ok with a denominator when nothing was found', () => {
    const report = buildReport({ examined: 12, findings: [], data: { root: '.' }, gate: LENIENT });
    expect(report).toEqual({
      status: 'ok',
      examined: 12,
      findings: [],
      summary: { errors: 0, warnings: 0, info: 0 },
      gate: { strict: false },
      data: { root: '.' },
    });
  });

  it('derives status and summary from the findings it was given', () => {
    const report = buildReport({
      examined: 3,
      findings: [finding('info'), finding('error'), finding('warning'), finding('error')],
      data: undefined,
      gate: { strict: true },
      durationMs: 42,
    });
    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 2, warnings: 1, info: 1 });
    expect(report.gate).toEqual({ strict: true });
    expect(report.durationMs).toBe(42);
  });

  it('cannot be built without examined — the type requires it and the schema refuses its absence', () => {
    const schema = reportSchema(z.object({ root: z.string() }).strict(), FindingSchema);
    const report = buildReport({ examined: 0, findings: [], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse(report).success).toBe(true);
    const withoutExamined: Record<string, unknown> = { ...report };
    delete withoutExamined['examined'];
    expect(schema.safeParse(withoutExamined).success).toBe(false);
  });
});

describe('buildErrorReport', () => {
  it('buildErrorReport keeps finished findings and derives summary from them', () => {
    // 🔑 `error` means "did not finish", not "did nothing": a run that checked
    // two of three things before one refused keeps what it found, and the
    // summary is still derived from that list rather than zeroed.
    const report = buildErrorReport({
      error: { code: 'INPUT_UNREADABLE', message: 'could not read docs/c.md' },
      gate: LENIENT,
      examined: 2,
      findings: [finding('warning'), finding('error')],
      data: { root: '.' },
      durationMs: 7,
    });
    expect(report).toEqual({
      status: 'error',
      examined: 2,
      findings: [finding('warning'), finding('error')],
      summary: { errors: 1, warnings: 1, info: 0 },
      gate: { strict: false },
      durationMs: 7,
      error: { code: 'INPUT_UNREADABLE', message: 'could not read docs/c.md' },
      data: { root: '.' },
    });
  });

  it('spells "nothing finished" at the call site and omits an unmeasured duration', () => {
    const report = buildErrorReport({
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
      gate: LENIENT,
      examined: 0,
      findings: [],
      data: null,
      durationMs: undefined,
    });
    expect(report.data).toBeNull();
    expect(report.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect('durationMs' in report).toBe(false);
  });
});

describe('reportSchema', () => {
  const schema = reportSchema(z.object({ root: z.string() }).strict(), FindingSchema);
  const errorReport = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...buildErrorReport({
      error: { code: 'INPUT_UNREADABLE', message: 'could not read docs/c.md' },
      gate: LENIENT,
      examined: 2,
      findings: [finding('warning')],
      data: { root: '.' },
      durationMs: 3,
    }),
    ...overrides,
  });

  it('constructs without throwing', () => {
    // The regression a per-branch refinement would have caused: a ZodEffects
    // cannot be a discriminatedUnion option, and zod throws at CONSTRUCTION.
    expect(() => reportSchema(z.object({}).strict(), FindingSchema)).not.toThrow();
  });

  it('reportSchema requires a finding schema', () => {
    // Tests are not typechecked, so the one-argument call is asserted at runtime.
    expect(() => reportSchema(z.object({}), undefined as never)).toThrow(/finding schema/);
  });

  it('is a refinement over a per-status discriminated union whose every option is strict and carries every envelope key', () => {
    const union = schema.innerType();
    expect(union).toBeInstanceOf(z.ZodDiscriminatedUnion);
    expect(union.options).toHaveLength(3);
    for (const option of union.options) {
      expect(option._def.unknownKeys).toBe('strict');
      for (const key of REPORT_ENVELOPE_KEYS) expect(Object.keys(option.shape)).toContain(key);
    }
  });

  it('refuses an envelope key nobody declared', () => {
    const report = buildReport({ examined: 1, findings: [finding('error')], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse(report).success).toBe(true);
    expect(schema.safeParse({ ...report, issueCounts: report.summary }).success).toBe(false);
  });

  it('refuses a status outside the vocabulary', () => {
    const report = buildReport({ examined: 1, findings: [], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse({ ...report, status: 'success' }).success).toBe(false);
  });

  it('rejects ok with a finding and findings with none', () => {
    const ok = buildReport({ examined: 1, findings: [], data: { root: '.' }, gate: LENIENT });
    const found = buildReport({ examined: 1, findings: [finding('info')], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse(found).success).toBe(true);
    expect(schema.safeParse({ ...found, status: 'ok' }).success).toBe(false);
    expect(schema.safeParse({ ...ok, status: 'findings' }).success).toBe(false);
  });

  it('rejects an ok report whose data is null', () => {
    const ok = buildReport({ examined: 1, findings: [], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse({ ...ok, data: null }).success).toBe(false);
  });

  it('accepts an error report carrying partial data, a real examined and the findings that finished', () => {
    expect(schema.safeParse(errorReport()).success).toBe(true);
    // …and one that finished nothing, with data null.
    expect(schema.safeParse(errorReport({ examined: 0, findings: [], summary: { errors: 0, warnings: 0, info: 0 }, data: null })).success)
      .toBe(true);
  });

  it('rejects an error report without error.code', () => {
    expect(schema.safeParse(errorReport({ error: { message: 'no code' } })).success).toBe(false);
    expect(schema.safeParse(errorReport({ error: 'a bare string' })).success).toBe(false);
    const withoutError = errorReport();
    delete withoutError['error'];
    expect(schema.safeParse(withoutError).success).toBe(false);
  });

  it('rejects error.code that is a finding code', () => {
    expect(schema.safeParse(errorReport({ error: { code: 'LINK_MISSING_TARGET', message: 'x' } })).success).toBe(false);
    // Positive control: the same document with a refusal code parses.
    expect(schema.safeParse(errorReport({ error: { code: 'RESOURCE_CHECK_BROKEN', message: 'x' } })).success).toBe(true);
  });

  it('rejects an error key on a completed report', () => {
    const ok = buildReport({ examined: 1, findings: [], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse({ ...ok, error: { code: 'INTERNAL_ERROR', message: 'x' } }).success).toBe(false);
  });

  it('rejects a report without gate', () => {
    const ok = buildReport({ examined: 1, findings: [], data: { root: '.' }, gate: LENIENT });
    const withoutGate: Record<string, unknown> = { ...ok };
    delete withoutGate['gate'];
    expect(schema.safeParse(withoutGate).success).toBe(false);
    expect(schema.safeParse({ ...ok, gate: {} }).success).toBe(false);
    expect(schema.safeParse({ ...ok, gate: { strict: false, extra: 1 } }).success).toBe(false);
  });

  it('rejects a summary that disagrees with the findings', () => {
    const found = buildReport({ examined: 1, findings: [finding('error')], data: { root: '.' }, gate: LENIENT });
    expect(schema.safeParse({ ...found, summary: { errors: 0, warnings: 1, info: 0 } }).success).toBe(false);
    expect(schema.safeParse(errorReport({ summary: { errors: 0, warnings: 0, info: 0 } })).success).toBe(false);
  });

  it('validates data through the schema it was given', () => {
    const report = buildReport({ examined: 1, findings: [], data: { root: 1 }, gate: LENIENT });
    expect(schema.safeParse(report).success).toBe(false);
  });

  it('validates findings through the finding schema it was given', () => {
    const narrowed = reportSchema(z.object({}).strict(), FindingSchema.extend({ line: z.number().int().positive() }).strict());
    const report = buildReport({ examined: 1, findings: [finding('error')], data: {}, gate: LENIENT });
    expect(narrowed.safeParse(report).success).toBe(false);
    expect(narrowed.safeParse({ ...report, findings: [{ ...finding('error'), line: 3 }] }).success).toBe(true);
  });
});
