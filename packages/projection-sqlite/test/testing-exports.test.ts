/**
 * The `./testing` subpath's runtime export set — a ratchet, both ways, as the `.` barrel's is in
 * `barrel-exports.test.ts`. A seam that destroys stored rows lives here and never on `.`.
 */

import { describe, expect, it } from 'vitest';

import { findBarrelDrift } from '../../dev-tools/src/pin-barrel-exports.js';

const TESTING_EXPORTS = ['evictRowSetForTest'];

describe('@vibe-agent-toolkit/projection-sqlite — the `./testing` subpath export surface', () => {
  it('exports exactly the recorded set, sorted — nothing added, dropped, or out of order', async () => {
    expect(findBarrelDrift(await import('../src/testing.js'), TESTING_EXPORTS)).toEqual({ added: [], removed: [], unsorted: [] });
  });
});
