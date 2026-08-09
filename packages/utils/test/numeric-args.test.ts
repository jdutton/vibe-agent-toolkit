/**
 * The rule is small; the value is that it lives in ONE place. These tests pin
 * the boundary and the message, because a CLI that says "expects a whole
 * number" without naming the option sends the user back to `--help` to guess.
 */

import { describe, expect, it } from 'vitest';

import { parseWholeNumberAtLeast } from '../src/numeric-args.js';

describe('parseWholeNumberAtLeast', () => {
  it('accepts a value exactly at the floor', () => {
    expect(parseWholeNumberAtLeast('1', 1, '--runs')).toBe(1);
  });

  it('accepts a value above the floor', () => {
    expect(parseWholeNumberAtLeast('42', 1, '--runs')).toBe(42);
  });

  it('rejects a value below the floor', () => {
    expect(() => parseWholeNumberAtLeast('0', 1, '--runs')).toThrow(/--runs/);
  });

  it('rejects a non-integer', () => {
    expect(() => parseWholeNumberAtLeast('1.5', 1, '--runs')).toThrow(/whole number/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseWholeNumberAtLeast('many', 1, '--runs')).toThrow(/'many'/);
  });

  it('names the flag the user typed, not a generic one', () => {
    // The positive control for the message: a hardcoded flag name would pass
    // every test above and still be useless to whoever typed the other option.
    expect(() => parseWholeNumberAtLeast('0', 1, '--timeout')).toThrow(/--timeout/);
  });
});
