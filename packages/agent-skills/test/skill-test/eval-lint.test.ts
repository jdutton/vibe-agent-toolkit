import { describe, expect, it } from 'vitest';

import type { EvalEntry } from '../../src/skill-test/eval-inputs.js';
import { lintEvalExpectations, lintToolExpectationExecutables } from '../../src/skill-test/eval-lint.js';

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

describe('lintToolExpectationExecutables', () => {
  const DECLARED = ['csvsum'];

  it('flags a separator-decorated typo of a declared executable and suggests it', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'typo', toolExpectations: { mustRun: ['csvsum-py'] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.evalId).toBe('typo');
    expect(warnings[0]?.message).toContain('csvsum-py');
    expect(warnings[0]?.message).toContain('did you mean "csvsum"');
  });

  it('flags a single-edit typo of a declared executable', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'edit', toolExpectations: { mustSucceed: ['csvsumm'] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('did you mean "csvsum"');
  });

  it('does not flag an exact declared name or a recognized launch form', () => {
    const warnings = lintToolExpectationExecutables(
      [
        makeEval({ id: 'exact', toolExpectations: { mustRun: ['csvsum'] } }),
        makeEval({ id: 'ext', toolExpectations: { mustRun: ['csvsum.py'] } }),
        makeEval({ id: 'dotslash', toolExpectations: { mustNotRun: ['./csvsum'] } }),
      ],
      DECLARED,
    );
    expect(warnings).toHaveLength(0);
  });

  it('does not flag a deliberate built-in/system tool that is unlike any declared name', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'builtin', toolExpectations: { mustRun: ['Bash', 'git'] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(0);
  });

  it('does not flag a prefix-sharing but distinct word (github vs git)', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'distinct', toolExpectations: { mustRun: ['github'] } })],
      ['git'],
    );
    expect(warnings).toHaveLength(0);
  });

  it('returns no warnings when the skill declares no executables', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'no-manifest', toolExpectations: { mustRun: ['csvsum-py'] } })],
      [],
    );
    expect(warnings).toHaveLength(0);
  });

  it('flags a typo across any toolExpectations channel and dedupes repeats', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'seq', toolExpectations: { mustRun: ['csvsum-py'], sequence: ['csvsum-py'] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(1);
  });

  it('ignores evals with no toolExpectations', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'plain' })],
      DECLARED,
    );
    expect(warnings).toHaveLength(0);
  });
});
