import { describe, expect, it } from 'vitest';

import {
  ToolEvalReportSchema,
  ToolVerdictBodySchema,
  ToolVerdictSchema,
} from '../../src/skill-test/tool-eval-schema.js';

const EVAL_ID = 'eval-1';
const REJECTS_UNKNOWN_TOP_LEVEL_KEYS = 'rejects unknown top-level keys (strict)';

const validBody = {
  mustRun: [{ name: 'bash', ran: true, evidence: 'saw bash call' }],
  mustNotRun: [{ name: 'rm', ran: false }],
  sequence: [{ steps: ['read', 'edit'], satisfied: true, evidence: 'read then edit' }],
  passed: true,
} as const;

const validVerdict = { evalId: EVAL_ID, ...validBody } as const;

describe('ToolVerdictBodySchema', () => {
  it('accepts a full body (minus evalId)', () => {
    expect(ToolVerdictBodySchema.safeParse(validBody).success).toBe(true);
  });

  it('accepts a minimal body (only passed)', () => {
    expect(ToolVerdictBodySchema.safeParse({ passed: true }).success).toBe(true);
  });

  it(REJECTS_UNKNOWN_TOP_LEVEL_KEYS, () => {
    expect(ToolVerdictBodySchema.safeParse({ passed: true, evalId: 'nope' }).success).toBe(false);
  });

  it('rejects an unknown key inside a mustRun entry (strict)', () => {
    expect(
      ToolVerdictBodySchema.safeParse({
        passed: true,
        mustRun: [{ name: 'bash', ran: true, oops: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown key inside a sequence entry (strict)', () => {
    expect(
      ToolVerdictBodySchema.safeParse({
        passed: true,
        sequence: [{ steps: ['a'], satisfied: true, oops: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty tool name', () => {
    expect(
      ToolVerdictBodySchema.safeParse({ passed: true, mustRun: [{ name: '', ran: true }] }).success,
    ).toBe(false);
  });
});

describe('ToolVerdictSchema', () => {
  it('round-trips a valid verdict', () => {
    expect(ToolVerdictSchema.parse(validVerdict)).toEqual(validVerdict);
  });

  it('requires evalId', () => {
    expect(ToolVerdictSchema.safeParse(validBody).success).toBe(false);
  });

  it('rejects an empty evalId', () => {
    expect(ToolVerdictSchema.safeParse({ ...validVerdict, evalId: '' }).success).toBe(false);
  });

  it(REJECTS_UNKNOWN_TOP_LEVEL_KEYS, () => {
    expect(ToolVerdictSchema.safeParse({ ...validVerdict, extra: 1 }).success).toBe(false);
  });
});

describe('ToolEvalReportSchema', () => {
  it('round-trips a report with multiple verdicts', () => {
    const report = { evals: [validVerdict, { evalId: 'eval-2', passed: false }] };
    expect(ToolEvalReportSchema.parse(report)).toEqual(report);
  });

  it('accepts an empty evals array', () => {
    expect(ToolEvalReportSchema.safeParse({ evals: [] }).success).toBe(true);
  });

  it(REJECTS_UNKNOWN_TOP_LEVEL_KEYS, () => {
    expect(ToolEvalReportSchema.safeParse({ evals: [], extra: 1 }).success).toBe(false);
  });

  it('rejects a malformed verdict inside evals', () => {
    expect(ToolEvalReportSchema.safeParse({ evals: [{ evalId: EVAL_ID }] }).success).toBe(false);
  });
});
