/**
 * I0 defect seeds over the `data` instance: a file past the output-rows cap, one past the
 * output-depth cap, and a YAML alias bomb whose expansion passes the output-rows cap, each planted alone into the clean data corpus. Each is exactly one DATA_FILE_NO_ROWS finding for its
 * pair, with the same path, state and code, in every arm (store-off, cold, warm, half the blob tier
 * evicted), judged by `vat resources check` and `vat resources query` (`../helpers/data-rows.ts` `dataDefectSeed`).
 */

import { expect, it } from 'vitest';

import { dataDefectRunner, EVERY_ARM } from '../helpers/data-rows.js';

const reportsAlike = dataDefectRunner(import.meta.url);

it('pastOutputRows: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('pastOutputRows')).toEqual(EVERY_ARM);
});
it('pastOutputDepth: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('pastOutputDepth')).toEqual(EVERY_ARM);
});
it('yamlAliasBomb: is its own one finding alike in every arm, beside every other file\'s rows, before its expansion is allocated', async () => {
  expect(await reportsAlike('yamlAliasBomb')).toEqual(EVERY_ARM);
});
