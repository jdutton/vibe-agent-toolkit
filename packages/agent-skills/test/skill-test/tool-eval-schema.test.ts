import { describe, expect, it } from 'vitest';

import {
  computeToolPassed,
  ToolEvalReportSchema,
  ToolVerdictBodySchema,
  ToolVerdictSchema,
  type ToolVerdictBody,
} from '../../src/skill-test/tool-eval-schema.js';

const EVAL_ID = 'eval-1';
const REJECTS_UNKNOWN_TOP_LEVEL_KEYS = 'rejects unknown top-level keys (strict)';

const validBody = {
  mustRun: [{ name: 'bash', ran: true, evidence: 'saw bash call' }],
  mustNotRun: [{ name: 'rm', ran: false }],
  mustSucceed: [{ name: 'csvsum', succeeded: true, evidence: 'no is_error on the invoking tool_result' }],
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

  it('accepts a mustSucceed entry (feature #148)', () => {
    expect(
      ToolVerdictBodySchema.safeParse({
        passed: true,
        mustSucceed: [{ name: 'csvsum', succeeded: true, evidence: 'no is_error' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown key inside a mustSucceed entry (strict)', () => {
    expect(
      ToolVerdictBodySchema.safeParse({
        passed: true,
        mustSucceed: [{ name: 'csvsum', succeeded: true, oops: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects a mustSucceed entry missing `succeeded`', () => {
    expect(
      ToolVerdictBodySchema.safeParse({ passed: true, mustSucceed: [{ name: 'csvsum' }] }).success,
    ).toBe(false);
  });

  it('rejects an empty mustSucceed tool name', () => {
    expect(
      ToolVerdictBodySchema.safeParse({ passed: true, mustSucceed: [{ name: '', succeeded: true }] }).success,
    ).toBe(false);
  });
});

describe('computeToolPassed', () => {
  const cases: { name: string; body: ToolVerdictBody; expected: boolean }[] = [
    { name: 'empty body (all sub-arrays absent) is vacuously true', body: { passed: false }, expected: true },
    {
      name: 'empty sub-arrays are vacuously true',
      body: { mustRun: [], mustNotRun: [], mustSucceed: [], sequence: [], passed: false },
      expected: true,
    },
    { name: 'every mustRun ran → true', body: { mustRun: [{ name: 'a', ran: true }], passed: false }, expected: true },
    { name: 'a mustRun that did NOT run → false', body: { mustRun: [{ name: 'a', ran: false }], passed: true }, expected: false },
    { name: 'a mustNotRun that ran → false', body: { mustNotRun: [{ name: 'rm', ran: true }], passed: true }, expected: false },
    { name: 'mustNotRun that did not run → true', body: { mustNotRun: [{ name: 'rm', ran: false }], passed: false }, expected: true },
    { name: 'every mustSucceed succeeded → true', body: { mustSucceed: [{ name: 'csvsum', succeeded: true }], passed: false }, expected: true },
    { name: 'a mustSucceed that did NOT succeed → false', body: { mustSucceed: [{ name: 'csvsum', succeeded: false }], passed: true }, expected: false },
    { name: 'every sequence satisfied → true', body: { sequence: [{ steps: ['a', 'b'], satisfied: true }], passed: false }, expected: true },
    { name: 'an unsatisfied sequence → false', body: { sequence: [{ steps: ['a', 'b'], satisfied: false }], passed: true }, expected: false },
    { name: 'all channels green → true', body: validBody, expected: true },
    {
      name: 'one failing mustSucceed among otherwise-green channels → false',
      body: { ...validBody, mustSucceed: [{ name: 'csvsum', succeeded: false }] },
      expected: false,
    },
  ];

  for (const { name, body, expected } of cases) {
    it(name, () => {
      expect(computeToolPassed(body)).toBe(expected);
    });
  }
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
