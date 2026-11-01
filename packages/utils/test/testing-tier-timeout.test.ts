/**
 * `atLeastTierTimeout` — an explicit test budget is a CEILING over the tier's
 * platform-scaled default, never a value that shrinks it, and never a multiple
 * that scales an hour-sized Unix budget by the Windows factor.
 */

import { describe, expect, it } from 'vitest';

import { atLeastTierTimeout } from '../src/testing.js';

const UNIX_TIER = 60_000;
const WINDOWS_TIER = 900_000;

describe('atLeastTierTimeout', () => {
  it('keeps a budget above the tier default exactly, so a Unix run is unchanged', () => {
    expect(atLeastTierTimeout(UNIX_TIER, 3_600_000)).toBe(3_600_000);
  });

  it('raises a budget below the tier default to the default, so it never shrinks the floor', () => {
    expect(atLeastTierTimeout(WINDOWS_TIER, 120_000)).toBe(WINDOWS_TIER);
  });

  it('does not scale a budget by the platform factor', () => {
    expect(atLeastTierTimeout(WINDOWS_TIER, 3_600_000)).toBe(3_600_000);
  });

  it.each([
    ['an undefined tier (a config that provides nothing)', undefined, 60_000],
    ['a NaN tier', Number.NaN, 60_000],
    ['a zero tier', 0, 60_000],
    ['a NaN budget', UNIX_TIER, Number.NaN],
    ['an infinite budget', UNIX_TIER, Number.POSITIVE_INFINITY],
  ])('throws on %s rather than returning a timeout that deletes the floor', (_label, tier, budget) => {
    expect(() => atLeastTierTimeout(tier as number, budget)).toThrow(/tier timeout|budget/);
  });
});
