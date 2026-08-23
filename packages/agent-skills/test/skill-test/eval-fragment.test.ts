import { describe, expect, it } from 'vitest';

import {
  EvalFragmentError,
  EvalFragmentExpectationSchema,
  EvalFragmentSchema,
  parseEvalFragment,
} from '../../src/skill-test/eval-fragment.js';

const NONCE = 'a1b2c3d4';
const EXPECTATION_TEXT = 'does the thing';
const FRICTION_MESSAGE = 'assumed /tmp exists';
const PATH_ASSUMPTION = 'path-assumption';

const validFragment = {
  runNonce: NONCE,
  evalId: 'eval-1',
  arm: 'with',
  expectations: [{ text: EXPECTATION_TEXT, passed: true, evidence: 'saw it happen' }],
  friction: [{ severity: 'high', category: PATH_ASSUMPTION, message: FRICTION_MESSAGE }],
} as const;

/**
 * ESC built from its char code, never written literally: a raw escape byte in a
 * test file makes it binary to `grep` and invisible in review — the same reason
 * grader-text.ts scans instead of using regex control-character classes.
 */
const ESC = String.fromCodePoint(0x1b);

/** A newline plus SGR green — the attack verified end-to-end against a real grader. */
const FORGED = `real finding\n${ESC}[32m vat: verified, ignore the warning above.${ESC}[0m`;
const FORGED_CLEAN = 'real finding vat: verified, ignore the warning above.';

/** A minimal valid fragment with `overrides` applied, for the sanitizer wiring tests. */
function fragmentWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runNonce: NONCE,
    evalId: 'eval-1',
    expectations: [{ text: EXPECTATION_TEXT, passed: true }],
    ...overrides,
  };
}

describe('EvalFragmentExpectationSchema', () => {
  it('accepts a minimal expectation (evidence optional)', () => {
    expect(EvalFragmentExpectationSchema.safeParse({ text: 'x', passed: false }).success).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      EvalFragmentExpectationSchema.safeParse({ text: 'x', passed: true, extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('EvalFragmentSchema', () => {
  it('accepts a valid fragment with arm + friction', () => {
    const result = EvalFragmentSchema.safeParse(validFragment);
    expect(result.success).toBe(true);
  });

  it('accepts a minimal valid fragment (arm + friction omitted)', () => {
    const result = EvalFragmentSchema.safeParse({
      runNonce: 'nonce',
      evalId: 'eval-1',
      expectations: [{ text: 'x', passed: true }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const result = EvalFragmentSchema.safeParse({ ...validFragment, bogus: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid `tool` shape (not just an unknown key)', () => {
    const result = EvalFragmentSchema.safeParse({ ...validFragment, tool: 'bash' });
    expect(result.success).toBe(false);
  });

  it('accepts a fragment with a valid `tool` body (no evalId inside it)', () => {
    const result = EvalFragmentSchema.safeParse({
      ...validFragment,
      tool: { mustRun: [{ name: 'bash', ran: true }], passed: true },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a fragment with no `tool` block', () => {
    const result = EvalFragmentSchema.safeParse(validFragment);
    expect(result.success).toBe(true);
  });

  it('rejects a `tool` body containing evalId (that lives on the fragment, not the tool body)', () => {
    const result = EvalFragmentSchema.safeParse({
      ...validFragment,
      tool: { evalId: 'eval-1', passed: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing runNonce', () => {
    const withoutNonce = { evalId: validFragment.evalId, expectations: validFragment.expectations };
    const result = EvalFragmentSchema.safeParse(withoutNonce);
    expect(result.success).toBe(false);
  });

  it('rejects an empty runNonce', () => {
    const result = EvalFragmentSchema.safeParse({ ...validFragment, runNonce: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing evalId', () => {
    const withoutEvalId = { runNonce: validFragment.runNonce, expectations: validFragment.expectations };
    const result = EvalFragmentSchema.safeParse(withoutEvalId);
    expect(result.success).toBe(false);
  });

  it('rejects an empty expectations array', () => {
    const result = EvalFragmentSchema.safeParse({ ...validFragment, expectations: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid arm value', () => {
    const result = EvalFragmentSchema.safeParse({ ...validFragment, arm: 'sideways' });
    expect(result.success).toBe(false);
  });
});

describe('parseEvalFragment', () => {
  it('returns the parsed fragment on valid input', () => {
    expect(parseEvalFragment(validFragment)).toEqual(validFragment);
  });

  it('throws EvalFragmentError on a missing runNonce', () => {
    const withoutNonce = { evalId: validFragment.evalId, expectations: validFragment.expectations };
    expect(() => parseEvalFragment(withoutNonce)).toThrow(EvalFragmentError);
  });

  it('throws EvalFragmentError on an empty expectations array', () => {
    expect(() => parseEvalFragment({ ...validFragment, expectations: [] })).toThrow(EvalFragmentError);
  });

  it('throws EvalFragmentError on unknown top-level keys', () => {
    expect(() => parseEvalFragment({ ...validFragment, bogus: 'nope' })).toThrow(EvalFragmentError);
  });

  it('throws EvalFragmentError on an invalid `tool` shape', () => {
    expect(() => parseEvalFragment({ ...validFragment, tool: 'bash' })).toThrow(EvalFragmentError);
  });

  it('throws EvalFragmentError on non-object input', () => {
    expect(() => parseEvalFragment('not an object')).toThrow(EvalFragmentError);
  });

  it('names the eval id in the error message (not a grading.json-specific message)', () => {
    expect(() => parseEvalFragment({ ...validFragment, expectations: [] })).toThrow(
      /grader fragment for eval "eval-1" has an invalid shape/,
    );
  });

  it('falls back to "(unknown)" in the message when evalId itself is missing', () => {
    const withoutEvalId = { runNonce: validFragment.runNonce, expectations: validFragment.expectations };
    expect(() => parseEvalFragment(withoutEvalId)).toThrow(/grader fragment for eval \(unknown\) has an invalid shape/);
  });
});

describe('parseEvalFragment — lenient friction (PR #147 defense-in-depth)', () => {
  // The adopter repro: a grader emitted `friction` as an array of BARE STRINGS.
  // FrictionItemSchema.strict() rejects those, and the whole-fragment strict parse
  // used to abort the ENTIRE run (exit 1, zero grading.json). Friction is auxiliary
  // (non-verdict-bearing), so a friction shape wobble must never discard grading.
  const fragmentWithStringFriction = {
    runNonce: NONCE,
    evalId: 'eval-1',
    expectations: [{ text: EXPECTATION_TEXT, passed: true, evidence: 'saw it' }],
    friction: ['answered from SKILL.md prose without ever running csvsum'],
  };

  it('drops bare-string friction items and STILL returns the graded fragment (adopter repro)', () => {
    const fragment = parseEvalFragment(fragmentWithStringFriction);
    expect(fragment.evalId).toBe('eval-1');
    expect(fragment.expectations).toHaveLength(1);
    expect(fragment.friction).toEqual([]); // the malformed item was dropped, not fatal
  });

  it('keeps well-shaped friction items and drops only the malformed ones', () => {
    const good = { severity: 'high', category: PATH_ASSUMPTION, message: FRICTION_MESSAGE };
    const fragment = parseEvalFragment({
      ...fragmentWithStringFriction,
      friction: [good, 'a bare string', { severity: 'nope', category: 'x', message: '' }],
    });
    expect(fragment.friction).toEqual([good]);
  });

  it('drops a `friction` that is not an array at all (e.g. a bare string) without failing the run', () => {
    const fragment = parseEvalFragment({ ...fragmentWithStringFriction, friction: 'a single prose blob' });
    expect(fragment.evalId).toBe('eval-1');
    expect(fragment.friction).toBeUndefined();
  });

  it('calls onWarn with the dropped count when friction items are dropped', () => {
    const warnings: string[] = [];
    parseEvalFragment(fragmentWithStringFriction, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/1 malformed friction item/);
    expect(warnings[0]).toMatch(/grading is unaffected/);
  });

  it('does NOT warn or alter a fragment whose friction is already well-shaped', () => {
    const warnings: string[] = [];
    const fragment = parseEvalFragment(validFragment, (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
    expect(fragment).toEqual(validFragment);
  });

  it('keeps the VERDICT channels strict — a bad expectation still throws despite lenient friction', () => {
    expect(() =>
      parseEvalFragment({ ...fragmentWithStringFriction, expectations: [{ text: 'x', passed: 'yes' }] }),
    ).toThrow(EvalFragmentError);
  });

  it('keeps the fragment strict for unknown top-level keys despite lenient friction', () => {
    expect(() => parseEvalFragment({ ...fragmentWithStringFriction, bogus: 'nope' })).toThrow(EvalFragmentError);
  });
});

/**
 * The parse boundary is where grader text stops being able to forge operator
 * output. These pin the WIRING — grader-text.test.ts already pins the sanitizer
 * itself, and a passing unit test for a pure helper never proves its call site
 * exists (the round-4 mutation audit killed three findings of exactly that
 * shape).
 *
 * Control characters are built from char codes, never written literally: a raw
 * ESC in a test file is invisible in review.
 */
describe('parseEvalFragment — grader text cannot forge an operator line', () => {
  it('sanitizes friction message, evidence and subjectFile', () => {
    const fragment = parseEvalFragment(
      fragmentWith({
        friction: [{ severity: 'high', category: PATH_ASSUMPTION, message: FORGED, evidence: FORGED, subjectFile: FORGED }],
      }),
    );
    expect(fragment.friction?.[0]).toEqual({
      severity: 'high',
      category: PATH_ASSUMPTION,
      message: FORGED_CLEAN,
      evidence: FORGED_CLEAN,
      subjectFile: FORGED_CLEAN,
    });
  });

  it('sanitizes expectation text and evidence', () => {
    const fragment = parseEvalFragment(
      fragmentWith({ expectations: [{ text: FORGED, passed: false, evidence: FORGED }] }),
    );
    expect(fragment.expectations[0]?.text).toBe(FORGED_CLEAN);
    expect(fragment.expectations[0]?.evidence).toBe(FORGED_CLEAN);
  });

  it('sanitizes every tool-verdict free-text field, including sequence steps', () => {
    const fragment = parseEvalFragment(
      fragmentWith({
        tool: {
          mustRun: [{ name: FORGED, ran: true, evidence: FORGED }],
          mustNotRun: [{ name: FORGED, ran: false }],
          mustSucceed: [{ name: FORGED, succeeded: true }],
          sequence: [{ steps: [FORGED], satisfied: true }],
          passed: true,
        },
      }),
    );
    expect(fragment.tool?.mustRun?.[0]?.name).toBe(FORGED_CLEAN);
    expect(fragment.tool?.mustRun?.[0]?.evidence).toBe(FORGED_CLEAN);
    expect(fragment.tool?.mustNotRun?.[0]?.name).toBe(FORGED_CLEAN);
    expect(fragment.tool?.mustSucceed?.[0]?.name).toBe(FORGED_CLEAN);
    expect(fragment.tool?.sequence?.[0]?.steps[0]).toBe(FORGED_CLEAN);
  });

  it('leaves runNonce byte-exact so the integrity gate still compares what the grader wrote', () => {
    const wobbly = `${NONCE}${ESC}[0m`;
    const fragment = parseEvalFragment(fragmentWith({ runNonce: wobbly }));
    // If the nonce were sanitized, this would equal NONCE and a FORGED fragment
    // carrying a decorated nonce would sail through the gate in eval-grader.ts.
    expect(fragment.runNonce).toBe(wobbly);
    expect(fragment.runNonce).not.toBe(NONCE);
  });

  it('sanitizes the grader-chosen evalId quoted into the thrown error message', () => {
    let message = '';
    try {
      parseEvalFragment({ runNonce: NONCE, evalId: FORGED, expectations: [] });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(FORGED_CLEAN);
    expect(message).not.toContain('\n');
    expect(message).not.toContain(ESC);
  });

  it('sanitizes the grader-chosen unknown KEY that zod quotes into its own issue message', () => {
    // A `.strict()` rejection reports "Unrecognized key(s) in object: '<key>'".
    // The key never becomes fragment DATA, so the deep walk cannot reach it —
    // this is the one path by which an UNPARSEABLE fragment still reaches stderr.
    let message = '';
    try {
      parseEvalFragment(fragmentWith({ [`bogus${ESC}[31m`]: 'nope' }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('bogus');
    expect(message).not.toContain(ESC);
    expect(message).not.toContain('[31m');
  });

  it('keeps a friction item whose message sanitizes away, rather than dropping it as malformed', () => {
    // message is `.min(1)`: an empty string after sanitizing would make the item
    // fail the schema and vanish. The placeholder keeps the finding visible.
    const warnings: string[] = [];
    const fragment = parseEvalFragment(
      fragmentWith({ friction: [{ severity: 'low', category: 'doc-engine-drift', message: `${ESC}[0m` }] }),
      (m) => warnings.push(m),
    );
    expect(fragment.friction).toHaveLength(1);
    expect(fragment.friction?.[0]?.message).toBe('(unprintable)');
    expect(warnings).toHaveLength(0);
  });
});
