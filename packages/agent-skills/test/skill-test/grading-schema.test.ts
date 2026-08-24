import { describe, expect, it } from 'vitest';

import {
  GradedExpectationSchema,
  GradingReportSchema,
  GradingSummarySchema,
} from '../../src/skill-test/grading-schema.js';

describe('GradingSummarySchema hardening', () => {
  it('accepts a valid non-negative integer summary with passed <= total', () => {
    const r = GradingSummarySchema.safeParse({ passed: 1, total: 2, failed: 1, pass_rate: 0.5 });
    expect(r.success).toBe(true);
  });

  it('rejects a negative count', () => {
    expect(GradingSummarySchema.safeParse({ passed: -1, total: 2 }).success).toBe(false);
  });

  it('rejects a float count', () => {
    expect(GradingSummarySchema.safeParse({ passed: 1.5, total: 2 }).success).toBe(false);
  });

  it('rejects passed greater than total', () => {
    expect(GradingSummarySchema.safeParse({ passed: 3, total: 2 }).success).toBe(false);
  });

  it('passes unknown fields through (Postel)', () => {
    const r = GradingSummarySchema.safeParse({ passed: 0, total: 0, viewer_url: 'https://x' });
    expect(r.success).toBe(true);
  });
});

/**
 * `arm` and `evalId` are the two fields that make the pair of `--baseline`
 * artifacts (grading.json = WITH, baseline.json = WITHOUT) tellable apart and
 * lineable up per eval. Both are OPTIONAL — an externally produced grading.json
 * carries neither — but both schemas are `.passthrough()`, so declaring them is
 * only load-bearing in one way: a value of the WRONG type must now be rejected
 * where an undeclared field would have sailed through untouched. These pin that.
 */
describe('baseline arm/evalId attribution fields', () => {
  const validReport = { expectations: [{ text: 'a', passed: true }], summary: { passed: 1, total: 1 } };

  it.each([
    { label: 'absent (an externally produced report declares no arm)', report: validReport },
    { label: "'with' (the treatment arm)", report: { ...validReport, arm: 'with' } },
    { label: "'without' (the control arm)", report: { ...validReport, arm: 'without' } },
  ])('accepts a report whose arm is $label', ({ report }) => {
    expect(GradingReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    { label: 'an arm outside the two-arm vocabulary', arm: 'both' },
    { label: 'a non-string arm', arm: 1 },
  ])('rejects $label', ({ arm }) => {
    expect(GradingReportSchema.safeParse({ ...validReport, arm }).success).toBe(false);
  });

  it('accepts a graded expectation carrying its source evalId', () => {
    const r = GradedExpectationSchema.safeParse({ text: 'a', passed: true, evalId: 'eval-1' });
    expect(r.success).toBe(true);
  });

  it('rejects a non-string evalId (attribution that cannot name an eval is not attribution)', () => {
    expect(GradedExpectationSchema.safeParse({ text: 'a', passed: true, evalId: 42 }).success).toBe(false);
  });
});
