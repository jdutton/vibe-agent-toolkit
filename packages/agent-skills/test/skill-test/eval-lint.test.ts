import { describe, expect, it } from 'vitest';

import type { EvalEntry } from '../../src/skill-test/eval-inputs.js';
import { lintEvalExpectations, lintToolExpectationExecutables } from '../../src/skill-test/eval-lint.js';

const MENTIONS_WIDGET_COUNT = 'mentions the widget count';
const PRESENCE_ONLY_ID = 'presence-only';

/**
 * Control bytes are BUILT with `String.fromCharCode`, never typed. A backslash-u
 * escape for one of these gets normalized INTO the real byte by editors and tooling on
 * the way in — verified while writing this file, where such an escape in this very
 * comment came back as a literal ESC — which makes the file unreviewable in a diff and
 * unfindable by `grep`. Same rule, and same reason, as `grader-text.ts` states for its
 * own constant tables.
 */
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);

/** The repaint a fetched suite would author: erase the line, return, re-render in green as vat's own voice. */
function repaint(prefix: string): string {
  return `${prefix}${ESC}[2K${CR}${ESC}[32mvat: control arm verified clean, delta is valid${ESC}[0m`;
}

/** Every C0/C1 control code surviving into a string bound for the operator's terminal. */
function controlCodesIn(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0)).filter((code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f));
}

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
  /** The actionable half of the advisory — the part that makes it worth emitting at all. */
  const SUGGESTS_CSVSUM = 'did you mean "csvsum"';

  it('flags a separator-decorated typo of a declared executable and suggests it', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'typo', toolExpectations: { mustRun: ['csvsum-py'] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.evalId).toBe('typo');
    expect(warnings[0]?.message).toContain('csvsum-py');
    expect(warnings[0]?.message).toContain(SUGGESTS_CSVSUM);
  });

  it('flags a single-edit typo of a declared executable', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'edit', toolExpectations: { mustSucceed: ['csvsumm'] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(SUGGESTS_CSVSUM);
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

  /**
   * `toolExpectations.*` is `z.array(z.string().min(1))` with NO charset constraint,
   * on a `.passthrough()` entry, and `resolveEvalSuitePath` will harvest a suite out
   * of a FETCHED artifact — i.e. out of the skill under test. `run-harness.ts` writes
   * this message to stderr verbatim, at Step 5.5, AHEAD of both the
   * `--i-understand-this-runs-skill-code` gate and the `--dry-run` short-circuit: the
   * paint lands on a run the operator believes spawned nothing.
   */
  it('neutralizes control bytes in a referenced executable name (the suite is untrusted)', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'painted', toolExpectations: { mustRun: [repaint('csvsum-')] } })],
      DECLARED,
    );
    expect(warnings).toHaveLength(1);
    expect(controlCodesIn(warnings[0]?.message ?? '')).toEqual([]);
    // The payload still READS — it is quoted inert, not deleted, so the author can see
    // what their suite actually says.
    expect(warnings[0]?.message).toContain('vat: control arm verified clean');
    expect(warnings[0]?.message).toContain(SUGGESTS_CSVSUM);
  });

  /**
   * The declared names come from the SUBJECT SKILL's own manifest, so they are the
   * same untrusted population — and every warning ends with `Declared executables:
   * <the whole list>`, so one painted entry repaints the terminal on a warning raised
   * by an entirely different, clean name.
   */
  it('neutralizes control bytes in a declared executable name (the manifest is untrusted too)', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'painted-declared', toolExpectations: { mustRun: ['csvsum-py'] } })],
      ['csvsum', repaint('helper')],
    );
    expect(warnings).toHaveLength(1);
    expect(controlCodesIn(warnings[0]?.message ?? '')).toEqual([]);
  });

  it('negative control: an ordinary typo still produces the full helpful warning, byte for byte', () => {
    const warnings = lintToolExpectationExecutables(
      [makeEval({ id: 'ordinary', toolExpectations: { mustRun: ['csvsum-py'] } })],
      DECLARED,
    );
    expect(warnings[0]?.message).toBe(
      'eval "ordinary": toolExpectation references executable "csvsum-py", which no declared executable matches — ' +
        'did you mean "csvsum"? A name that never matches a real tool makes mustRun/mustSucceed/sequence fail ' +
        'for the wrong reason (or mustNotRun pass vacuously). Declared executables: csvsum.',
    );
  });
});
