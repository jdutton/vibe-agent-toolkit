/**
 * I0 defect seeds over the `data` instance: a file past the input-bytes cap, and one whose rows
 * pass the output-bytes cap, each planted alone into the clean data corpus. Each is exactly
 * one DATA_FILE_NO_ROWS finding for its pair, with the same path, state and code, in every arm (store-off, cold, warm, half the
 * blob tier evicted), judged by `vat resources check` and `vat resources query` (`../helpers/data-rows.ts` `dataDefectSeed`).
 */

import { expect, it } from 'vitest';

import { dataDefectRunner, EVERY_ARM } from '../helpers/data-rows.js';

const reportsAlike = dataDefectRunner(import.meta.url);

it('pastInputBytes: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('pastInputBytes')).toEqual(EVERY_ARM);
});
it('pastOutputBytes: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('pastOutputBytes')).toEqual(EVERY_ARM);
});
