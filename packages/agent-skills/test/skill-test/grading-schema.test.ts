import { describe, expect, it } from 'vitest';

import { GradingSummarySchema } from '../../src/skill-test/grading-schema.js';

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
