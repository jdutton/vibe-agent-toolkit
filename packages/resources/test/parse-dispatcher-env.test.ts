/**
 * The pool policy's ENVIRONMENT surface.
 *
 * `ParsePoolPolicy` exists to be measured rather than guessed at — its own
 * docstrings say so of `transport`. A knob that only a caller in this repository
 * can set is not measurable from outside, and the lab measures by spawning the
 * binary and controlling its environment, so an unreachable knob is one the lab
 * cannot vary at all.
 *
 * These cases pin the two properties that make a knob usable as an experiment
 * arm: the environment is READ, and an explicit policy value BEATS it — so a
 * caller that has already decided cannot have its decision overridden by an
 * ambient variable it never saw.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ParseDispatcher, type ParsableRemainder, type ParsePoolPolicy } from '../src/parse-dispatcher.js';
import { type ParsePool, type ParsePoolOptions } from '../src/parse-pool.js';

import { inertPool, mutableCache } from './parse-dispatcher-fixture.js';

/** Env names this suite sets, cleared after every case. */
const POOL_ENV = 'VAT_PARSE_POOL';
const SIZE_ENV = 'VAT_PARSE_POOL_SIZE';
const MISSES_ENV = 'VAT_PARSE_POOL_MIN_MISSES';
const LOOK_AHEAD_ENV = 'VAT_PARSE_LOOK_AHEAD';

/**
 * Activate a dispatcher and report the size the pool was built with.
 *
 * @param policy - Policy under test, minus the capturing `createPool`
 * @param misses - Misses the cache should report
 * @param remaining - Markdown documents still needing a parse
 * @returns The size the pool was asked for, or `null` if no pool was built
 */
function sizeFromActivation(
  policy: ParsePoolPolicy,
  misses: number,
  remaining: number,
): number | null {
  let asked: number | null = null;
  const { cache, accrue } = mutableCache();
  const dispatcher = new ParseDispatcher(cache, {
    ...policy,
    createPool: (options?: ParsePoolOptions): ParsePool => {
      asked = options?.size ?? null;
      return inertPool();
    },
  });
  accrue({ misses });
  const tally: ParsableRemainder = { markdown: remaining, html: 0 };
  dispatcher.considerActivation(() => tally);
  return asked;
}

afterEach(() => {
  delete process.env[POOL_ENV];
  delete process.env[SIZE_ENV];
  delete process.env[MISSES_ENV];
  delete process.env[LOOK_AHEAD_ENV];
});

/**
 * The look-ahead a dispatcher built under the current environment reports.
 *
 * @param policy - Policy under test
 * @returns The multiple of the width preparation may run ahead by
 */
function lookAheadOf(policy: ParsePoolPolicy): number {
  return new ParseDispatcher(mutableCache().cache, policy).lookAhead;
}

describe('ParsePoolPolicy.size — reachable from the environment', () => {
  it('takes the worker ceiling from VAT_PARSE_POOL_SIZE', () => {
    // The pin the cross-machine comparison needs: this box would otherwise size
    // itself from its own core count, so two machines could not be held at one
    // width and any difference between them would confound width with platform.
    process.env[POOL_ENV] = '1';
    process.env[SIZE_ENV] = '3';

    expect(sizeFromActivation({}, 1000, 4096)).toBe(3);
  });

  it('lets an explicit policy size BEAT the environment', () => {
    process.env[POOL_ENV] = '1';
    process.env[SIZE_ENV] = '3';

    expect(sizeFromActivation({ size: 6 }, 1000, 4096)).toBe(6);
  });

  it('ignores a value that is not a positive whole number, rather than sizing to NaN', () => {
    // A pool built with NaN workers is not a smaller pool, it is an unusable
    // one — and the failure would surface as a hung command, far from the typo.
    process.env[POOL_ENV] = '1';
    process.env[SIZE_ENV] = 'wide';

    // Null is the discriminating answer, and both halves of it matter. Coerced,
    // `size` would be NaN — and `NaN < 1` is false, so a pool WOULD be built,
    // with NaN workers. Ignored, the width falls through to the byte estimate,
    // which this dispatcher has parsed nothing to build: no sample, no claim, no
    // pool.
    expect(sizeFromActivation({}, 1000, 4096)).toBeNull();
  });
});

describe('ParsePoolPolicy.lookAhead — reachable from the environment', () => {
  // Its own docstring calls the value provisional and the A/B that would read it
  // "the next step". A constant no experiment arm can vary is one that stays
  // provisional forever, which is the state `size` was in until it was wired.
  it('takes the preparation look-ahead from VAT_PARSE_LOOK_AHEAD', () => {
    process.env[LOOK_AHEAD_ENV] = '9';

    expect(lookAheadOf({})).toBe(9);
  });

  it('lets an explicit policy look-ahead BEAT the environment', () => {
    process.env[LOOK_AHEAD_ENV] = '9';

    expect(lookAheadOf({ lookAhead: 2 })).toBe(2);
  });

  it('ignores a value that is not a positive whole number', () => {
    // A NaN look-ahead makes `claimed - emitted < width * NaN` false forever, so
    // the claim side stalls at the head and the pool starves — a hang, far from
    // the typo, exactly as a NaN width would be.
    process.env[LOOK_AHEAD_ENV] = 'deep';

    expect(lookAheadOf({})).toBe(4);
  });
});

describe('ParsePoolPolicy.missThreshold — reachable from the environment', () => {
  it('takes the activation threshold from VAT_PARSE_POOL_MIN_MISSES', () => {
    process.env[POOL_ENV] = '1';
    process.env[MISSES_ENV] = '1';

    // One miss is below the 128 default, so a pool exists here only if the
    // environment was read.
    expect(sizeFromActivation({ size: 2 }, 1, 256)).toBe(2);
  });

  it('does not activate below the threshold the environment named', () => {
    process.env[POOL_ENV] = '1';
    process.env[MISSES_ENV] = '500';

    expect(sizeFromActivation({ size: 2 }, 499, 256)).toBeNull();
  });

  it('lets an explicit policy threshold BEAT the environment', () => {
    process.env[POOL_ENV] = '1';
    process.env[MISSES_ENV] = '500';

    expect(sizeFromActivation({ size: 2, missThreshold: 1 }, 1, 256)).toBe(2);
  });
});
