/**
 * The barrel pin sees each kind of drift — otherwise twenty green pin suites
 * across the workspace would prove nothing about the barrels they name.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift, runtimeExportNames } from '../src/pin-barrel-exports.js';

const BARREL: Record<string, unknown> = { zeta: 1, Alpha: 2, beta: 3, _under: 4 };

describe('findBarrelDrift', () => {
  it('reports nothing when the pin is exactly the barrel, sorted by code unit', () => {
    const pinned = runtimeExportNames(BARREL);

    expect(pinned).toEqual(['Alpha', '_under', 'beta', 'zeta']);
    expect(findBarrelDrift(BARREL, pinned)).toEqual({ added: [], removed: [], unsorted: [] });
  });

  it('names an export the pin does not record as added', () => {
    expect(findBarrelDrift(BARREL, ['Alpha', '_under', 'beta']).added).toEqual(['zeta']);
  });

  it('names a recorded export the barrel no longer has as removed', () => {
    expect(findBarrelDrift(BARREL, ['Alpha', '_under', 'beta', 'gone', 'zeta']).removed).toEqual(['gone']);
  });

  it('names every pinned entry that is out of sorted position', () => {
    // The same set, one swap: both displaced entries are named, nothing else.
    expect(findBarrelDrift(BARREL, ['Alpha', 'beta', '_under', 'zeta']).unsorted).toEqual(['beta', '_under']);
  });

  it('ignores type-only exports, which never reach the runtime namespace', () => {
    // A `type X` export leaves no key on the module object, so it cannot be
    // pinned or drift here — the floor of a runtime pin, stated as a test.
    expect(runtimeExportNames({})).toEqual([]);
  });
});
