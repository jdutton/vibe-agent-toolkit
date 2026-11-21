/**
 * I0, unseeded, the `partialEviction` slice of the gate: with part of the blob tier
 * deleted from a primed store, every verb answers the gate fixture exactly as it does
 * with the store off. The arm and the keys it evicts: `../helpers/cache-differential.ts`.
 */

import { describe, it } from 'vitest';

import { GATE_SLICES, gateSuite } from '../helpers/cache-differential.js';

describe('a partly evicted blob tier changes what a run costs, never what it answers', () => {
  const gate = gateSuite(GATE_SLICES.partialEviction, import.meta.url);

  it('answers every verb exactly as store-off does, with a zero refusal census', gate.expectAgreement);
});
