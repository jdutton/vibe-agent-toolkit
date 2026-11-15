/**
 * When are two arms the same measurement? Only when BOTH the instrument (bytes
 * included, via the closure digest) and the environment match — either one
 * differing is a real A/B. Pure: the digest itself is covered by
 * `integration/closure.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { InstrumentVersion } from '../src/envelope/coordinate.js';
import { EMPTY_ARM_ENVIRONMENT } from '../src/harness/arm-env.js';
import { indistinguishableArms } from '../src/harness/closure.js';

const DIST: InstrumentVersion = { version: '0.2.0', commit: null, dirty: null, closure: 'a'.repeat(64) };

describe('indistinguishableArms', () => {
  it('holds for one instrument under one environment', () => {
    expect(
      indistinguishableArms(
        { instrument: DIST, env: EMPTY_ARM_ENVIRONMENT },
        { instrument: { ...DIST }, env: { set: {}, unset: [] } },
      ),
    ).toBe(true);
  });

  it('does not hold when only the closure differs', () => {
    expect(
      indistinguishableArms(
        { instrument: DIST, env: EMPTY_ARM_ENVIRONMENT },
        { instrument: { ...DIST, closure: 'b'.repeat(64) }, env: EMPTY_ARM_ENVIRONMENT },
      ),
    ).toBe(false);
  });

  it('does not hold when only the environment differs', () => {
    expect(
      indistinguishableArms(
        { instrument: DIST, env: EMPTY_ARM_ENVIRONMENT },
        { instrument: DIST, env: { set: {}, unset: ['CLAUDE_CONFIG_DIR'] } },
      ),
    ).toBe(false);
  });
});
