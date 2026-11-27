/**
 * I0 defect seeds over the `data` instance: a file past the input-bytes cap, and one whose rows
 * pass the output-bytes cap, each planted alone into the clean data corpus. Each refuses exactly
 * its one pair, with the same path, state and code, in every arm (store-off, cold, warm, half the
 * blob tier evicted), judged by `vat resources check` (`../helpers/data-rows.ts` `dataDefectSeed`).
 */

import { expect, it } from 'vitest';

import { dataDefectRunner, EVERY_ARM } from '../helpers/data-rows.js';

const refusesAlike = dataDefectRunner(import.meta.url);

it('pastInputBytes: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('pastInputBytes')).toEqual(EVERY_ARM);
});
it('pastOutputBytes: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('pastOutputBytes')).toEqual(EVERY_ARM);
});
