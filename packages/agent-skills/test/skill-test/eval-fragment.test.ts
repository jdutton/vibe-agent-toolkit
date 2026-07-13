import { describe, expect, it } from 'vitest';

import {
  EvalFragmentError,
  EvalFragmentExpectationSchema,
  EvalFragmentSchema,
  parseEvalFragment,
} from '../../src/skill-test/eval-fragment.js';

const validFragment = {
  runNonce: 'a1b2c3d4',
  evalId: 'eval-1',
  arm: 'with',
  expectations: [{ text: 'does the thing', passed: true, evidence: 'saw it happen' }],
  friction: [{ severity: 'high', category: 'path-assumption', message: 'assumed /tmp exists' }],
} as const;

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
    runNonce: 'a1b2c3d4',
    evalId: 'eval-1',
    expectations: [{ text: 'does the thing', passed: true, evidence: 'saw it' }],
    friction: ['answered from SKILL.md prose without ever running dxa'],
  };

  it('drops bare-string friction items and STILL returns the graded fragment (adopter repro)', () => {
    const fragment = parseEvalFragment(fragmentWithStringFriction);
    expect(fragment.evalId).toBe('eval-1');
    expect(fragment.expectations).toHaveLength(1);
    expect(fragment.friction).toEqual([]); // the malformed item was dropped, not fatal
  });

  it('keeps well-shaped friction items and drops only the malformed ones', () => {
    const good = { severity: 'high', category: 'path-assumption', message: 'assumed /tmp exists' };
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
