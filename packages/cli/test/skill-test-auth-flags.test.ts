/**
 * Unit tests for the shared `--auth` / `--require-auth` flag validation used by
 * `vat skill test run` and `vat skill test configure`.
 */

import { describe, expect, it } from 'vitest';

import {
  assertValidAuth,
  assertValidRequireAuth,
  VALID_AUTH_VALUES,
  VALID_REQUIRE_AUTH_VALUES,
} from '../src/commands/skill/test/auth-flags.js';

describe('assertValidAuth', () => {
  it('accepts undefined (flag omitted)', () => {
    expect(() => assertValidAuth(undefined)).not.toThrow();
  });

  it.each(VALID_AUTH_VALUES)('accepts %s', (value) => {
    expect(() => assertValidAuth(value)).not.toThrow();
  });

  it('rejects an unrecognized value with a usage message listing the valid set', () => {
    expect(() => assertValidAuth('bogus')).toThrow(
      '--auth must be one of: inherit, subscription, api-key, auto. Got: bogus',
    );
  });
});

describe('assertValidRequireAuth', () => {
  it('accepts undefined (flag omitted)', () => {
    expect(() => assertValidRequireAuth(undefined)).not.toThrow();
  });

  it.each(VALID_REQUIRE_AUTH_VALUES)('accepts %s', (value) => {
    expect(() => assertValidRequireAuth(value)).not.toThrow();
  });

  it('rejects inherit/auto (cannot be *required*)', () => {
    expect(() => assertValidRequireAuth('inherit')).toThrow('--require-auth must be one of: subscription, api-key');
    expect(() => assertValidRequireAuth('auto')).toThrow('--require-auth must be one of: subscription, api-key');
  });
});
