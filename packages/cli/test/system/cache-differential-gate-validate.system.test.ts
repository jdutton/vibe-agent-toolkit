/**
 * I0, unseeded, the `vatValidate` slice of the gate: `vat validate` answers the gate
 * fixture in every arm, partial eviction included, exactly as it does with the store
 * off: the same findings in the same order and the same exit code.
 */

import { describe, it } from 'vitest';

import { GATE_SLICES, gateSuite } from '../helpers/cache-differential.js';

describe('vat validate answers alike whether or not the projection store is engaged', () => {
  const gate = gateSuite(GATE_SLICES.vatValidate, import.meta.url);

  it('answers in every arm exactly as store-off does, with a zero refusal census', gate.expectAgreement);
});
