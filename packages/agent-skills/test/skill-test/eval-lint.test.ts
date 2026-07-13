import { describe, expect, it } from 'vitest';

import type { EvalEntry } from '../../src/skill-test/eval-inputs.js';
import { lintEvalExpectations } from '../../src/skill-test/eval-lint.js';

const MENTIONS_WIDGET_COUNT = 'mentions the widget count';
const PRESENCE_ONLY_ID = 'presence-only';

/** Minimal valid eval entry, overridable per test. */
function makeEval(overrides: Partial<EvalEntry> & { id: string }): EvalEntry {
  return {
    prompt: 'do the thing',
    expectations: ['mentions the thing'],
    ...overrides,
  };
}

describe('lintEvalExpectations', () => {
  it('warns on a pure "mentions X" only eval', () => {
    const warnings = lintEvalExpectations([
      makeEval({ id: PRESENCE_ONLY_ID, expectations: [MENTIONS_WIDGET_COUNT] }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.evalId).toBe(PRESENCE_ONLY_ID);
    expect(warnings[0]?.message).toContain('presence-only');
    expect(warnings[0]?.message).toContain('toolExpectations');
  });

  it('does not warn when an expectation is negative/discriminating', () => {
    const warnings = lintEvalExpectations([
      makeEval({
        id: 'negative-check',
        expectations: ['does not include a hallucinated file path'],
      }),
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn when the eval declares toolExpectations', () => {
    const warnings = lintEvalExpectations([
      makeEval({
        id: 'has-tool-expectations',
        expectations: [MENTIONS_WIDGET_COUNT],
        toolExpectations: { mustRun: ['bash'] },
      }),
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn when presence-only is mixed with a discriminating expectation', () => {
    const warnings = lintEvalExpectations([
      makeEval({
        id: 'mixed',
        expectations: [
          MENTIONS_WIDGET_COUNT,
          'does not fabricate a vendor name that is absent from the input',
        ],
      }),
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn on an eval with empty expectations', () => {
    const warnings = lintEvalExpectations([
      makeEval({ id: 'empty', expectations: [] }),
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn when no expectation matches the presence vocabulary at all', () => {
    const warnings = lintEvalExpectations([
      makeEval({ id: 'unrelated-prose', expectations: ['is helpful and concise'] }),
    ]);
    expect(warnings).toHaveLength(0);
  });

  it('returns one warning per flagged eval across a multi-eval suite', () => {
    const warnings = lintEvalExpectations([
      makeEval({ id: 'weak-1', expectations: ['includes the total'] }),
      makeEval({ id: 'strong-1', expectations: ['does not include the total'] }),
      makeEval({ id: 'weak-2', expectations: ['references the customer name'] }),
    ]);
    expect(warnings.map((w) => w.evalId)).toEqual(['weak-1', 'weak-2']);
  });
});
