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
});
