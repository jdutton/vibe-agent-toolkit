/**
 * I0 defect seeds over the `data` instance: a file past the output-rows cap, one past the
 * output-depth cap, a YAML alias bomb whose expansion passes the output-rows cap, and a YAML byte bomb
 * (one long anchored string aliased many times) whose expansion passes the output-bytes cap, each
 * planted alone into the clean data corpus. Each refuses exactly its one
 * pair, with the same path, state and code, in every arm (store-off, cold, warm, half the blob tier
 * evicted), judged by `vat resources check` (`../helpers/data-rows.ts` `dataDefectSeed`).
 */

import { expect, it } from 'vitest';

import { dataDefectRunner, EVERY_ARM } from '../helpers/data-rows.js';

const refusesAlike = dataDefectRunner(import.meta.url);

it('pastOutputRows: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('pastOutputRows')).toEqual(EVERY_ARM);
});
it('pastOutputDepth: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('pastOutputDepth')).toEqual(EVERY_ARM);
});
it('yamlAliasBomb: refuses its one pair alike in every arm, before its expansion is allocated', async () => {
  expect(await refusesAlike('yamlAliasBomb')).toEqual(EVERY_ARM);
});
it('yamlByteBomb: refuses its one pair alike in every arm, before its expansion is written out', async () => {
  expect(await refusesAlike('yamlByteBomb')).toEqual(EVERY_ARM);
});
