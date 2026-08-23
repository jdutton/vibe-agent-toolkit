import { describe, expect, it } from 'vitest';

import {
  GradingSkewError,
  parseGradingJson,
  reconcileGrading,
} from '../../src/skill-test/grading-adapter.js';

const VALID = {
  summary: { passed: 3, total: 3 },
  expectations: [{ text: 'uses bundled script', passed: true, evidence: 'ran scripts/x.py' }],
  // skill-creator may add fields we ignore:
  viewer_url: 'http://localhost:1234',
};

describe('parseGradingJson', () => {
  it('reads the load-bearing fields and passes unknown ones through silently', () => {
    const g = parseGradingJson(VALID);
    expect(g.summary.passed).toBe(3);
    expect(g.expectations[0]?.passed).toBe(true);
  });

  it('throws GradingSkewError when expectations is missing', () => {
    expect(() => parseGradingJson({ summary: { passed: 1, total: 1 } })).toThrow(GradingSkewError);
  });

  it('throws GradingSkewError when an expectation lacks passed', () => {
    expect(() =>
      parseGradingJson({ summary: { passed: 0, total: 1 }, expectations: [{ text: 'x' }] }),
    ).toThrow(GradingSkewError);
  });

  it('GradingSkewError message names the missing field', () => {
    expect.assertions(1);
    try {
      parseGradingJson({ summary: { passed: 1, total: 1 } });
    } catch (e) {
      expect((e as Error).message).toContain('expectations');
    }
  });

  it('accepts the canonical skill-creator grading.json (flat shape + optional sections)', () => {
    // Mirrors references/schemas.md grading.json: flat top-level expectations +
    // summary, plus documented optional sections that must pass through untouched.
    const canonical = {
      expectations: [
        { text: 'Output includes the name', passed: true, evidence: 'Step 3: extracted names' },
        { text: 'Spreadsheet has SUM in B10', passed: false, evidence: 'No spreadsheet was created' },
      ],
      summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
      execution_metrics: { total_tool_calls: 15 },
      timing: { total_duration_seconds: 191 },
      claims: [{ claim: '12 fields', type: 'factual', verified: true }],
      eval_feedback: { overall: 'Assertions check presence but not correctness.' },
    };
    const g = parseGradingJson(canonical);
    expect(g.summary).toEqual({ passed: 1, total: 2 });
    expect(g.expectations).toHaveLength(2);
    expect(g.expectations[1]?.passed).toBe(false);
  });

  it('rejects the per-eval nested shape with a targeted, actionable message', () => {
    // The grader (an LLM) wraps results in `evals: [...]` when the top-level
    // shape is under-specified. vat must reject this loudly, not flatten it
    // silently — see Bug E. The message must point at the real fix.
    const nested = {
      skill_name: 'poc-skill',
      evals: [
        {
          id: 1,
          prompt: 'Say hello',
          expectations: [{ text: 'contains hello', passed: true }],
          summary: { passed: 1, total: 1 },
        },
      ],
    };
    expect(() => parseGradingJson(nested)).toThrow(GradingSkewError);
    try {
      parseGradingJson(nested);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('evals');
      expect(msg).toContain('top-level `expectations`');
    }
  });
});

describe('reconcileGrading', () => {
  it('returns recomputed counts when summary agrees with expectations', () => {
    const v = reconcileGrading({
      summary: { passed: 1, total: 2 },
      expectations: [
        { text: 'a', passed: true },
        { text: 'b', passed: false },
      ],
    });
    expect(v).toEqual({ passed: 1, total: 2, allPassed: false });
  });

  it('reports allPassed when every expectation passed', () => {
    const v = reconcileGrading({
      summary: { passed: 2, total: 2 },
      expectations: [
        { text: 'a', passed: true },
        { text: 'b', passed: true },
      ],
    });
    expect(v).toEqual({ passed: 2, total: 2, allPassed: true });
  });

  it('throws GradingSkewError when there are zero expectations (nothing graded is never a pass)', () => {
    expect(() => reconcileGrading({ summary: { passed: 0, total: 0 }, expectations: [] })).toThrow(
      GradingSkewError,
    );
  });

  it('throws GradingSkewError when the grader summary disagrees with the recomputed counts', () => {
    expect(() =>
      reconcileGrading({
        summary: { passed: 5, total: 5 },
        expectations: [
          { text: 'a', passed: true },
          { text: 'b', passed: true },
        ],
      }),
    ).toThrow(GradingSkewError);
  });

  it('throws when summary undercounts a failing expectation (summary {5,5} but one expectation failed)', () => {
    const expectations = [
      { text: '1', passed: true },
      { text: '2', passed: true },
      { text: '3', passed: true },
      { text: '4', passed: true },
      { text: '5', passed: false },
    ];
    expect(() => reconcileGrading({ summary: { passed: 5, total: 5 }, expectations })).toThrow(
      GradingSkewError,
    );
  });
});

describe('parseGradingJson — runNonce passthrough', () => {
  it('carries a top-level runNonce onto the normalized grading', () => {
    const g = parseGradingJson({ ...VALID, runNonce: 'abc123' });
    expect(g.runNonce).toBe('abc123');
  });

  it('leaves runNonce undefined when absent', () => {
    expect(parseGradingJson(VALID).runNonce).toBeUndefined();
  });
});

describe('parseGradingJson — attribution passthrough', () => {
  // `evalId` and `arm` are optional because an externally produced grading.json
  // legitimately carries no attribution. That is a reason to OMIT an absent field,
  // never to discard a present one — the schema parses both, and `evalId` is what
  // lets a reader line the two --baseline artifacts up per eval.
  it('carries a per-expectation evalId onto the normalized grading', () => {
    const g = parseGradingJson({
      ...VALID,
      expectations: [{ text: 'uses bundled script', passed: true, evalId: 'e1' }],
    });
    expect(g.expectations[0]?.evalId).toBe('e1');
  });

  it('carries a top-level arm onto the normalized grading', () => {
    expect(parseGradingJson({ ...VALID, arm: 'without' }).arm).toBe('without');
  });

  it('leaves evalId and arm undefined when the report carries no attribution', () => {
    const g = parseGradingJson(VALID);
    expect(g.arm).toBeUndefined();
    expect(g.expectations[0]?.evalId).toBeUndefined();
  });
});

describe('parseGradingJson — the rejection message is not a paint surface', () => {
  // The reachable route is zod's ENUM error, which echoes the RECEIVED VALUE verbatim:
  // `Invalid enum value. Expected 'with' | 'without', received '<whatever the report said>'`.
  // `arm` is read straight off an externally produced grading.json, so that value is
  // attacker-controlled and lands in an operator-facing message.
  //
  // Measured, so nobody re-derives it: the unrecognized-KEY route does NOT exist here —
  // GradingReportSchema is `.passthrough()`, so a forged key is accepted rather than
  // reported (that route belongs to the `.strict()` fragment schema in a sibling module).
  // A type mismatch on `passed`/`text` names the type, never the value. An earlier draft
  // of this test used the forged-key fixture and passed with the sanitizer REMOVED.
  const ESC = String.fromCodePoint(27);
  const CR = String.fromCodePoint(13);
  const forged = `x${ESC}[2K${CR}${ESC}[32mvat: grading verified${ESC}[0m`;

  it('strips escape and control bytes a report smuggled through a rejected enum value', () => {
    let message = '';
    try {
      parseGradingJson({ ...VALID, arm: forged });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(ESC);
    expect(message).not.toContain(CR);
  });

  it('still names the offending field, so sanitizing did not blind the operator', () => {
    expect(() => parseGradingJson({ ...VALID, arm: forged })).toThrow(/invalid field at "arm"/);
  });
});
