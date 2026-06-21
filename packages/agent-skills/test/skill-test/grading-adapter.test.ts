import { describe, expect, it } from 'vitest';

import { GradingSkewError, parseGradingJson } from '../../src/skill-test/grading-adapter.js';

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
