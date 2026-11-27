/**
 * I0 defect seeds over the `data` instance: a NUL byte, malformed JSON, a comment in strict JSON,
 * closers that never match what they close, keys that differ only by a lone surrogate, and in YAML a
 * `%YAML 1.1` directive, malformed YAML and an alias naming no anchor, each planted alone into the clean data corpus. Each refuses exactly its one pair, with the same path,
 * state and code, in every arm (store-off, cold, warm, half the blob tier evicted),
 * judged by `vat resources check` (`../helpers/data-rows.ts` `dataDefectSeed`).
 */

import { expect, it } from 'vitest';

import { dataDefectRunner, EVERY_ARM } from '../helpers/data-rows.js';

const refusesAlike = dataDefectRunner(import.meta.url);

it('nulByte: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('nulByte')).toEqual(EVERY_ARM);
});
it('malformed: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('malformed')).toEqual(EVERY_ARM);
});
it('commentInStrict: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('commentInStrict')).toEqual(EVERY_ARM);
});
it('mismatchedCloser: refuses its one pair alike in every arm, without recursing into the parse', async () => {
  expect(await refusesAlike('mismatchedCloser')).toEqual(EVERY_ARM);
});
it('loneSurrogateKeys: refuses its one pair alike in every arm, rather than two keys colliding as text', async () => {
  expect(await refusesAlike('loneSurrogateKeys')).toEqual(EVERY_ARM);
});
it('yamlVersion11: refuses its one pair alike in every arm, rather than reading YAML 1.1 under 1.2', async () => {
  expect(await refusesAlike('yamlVersion11')).toEqual(EVERY_ARM);
});
it('yamlMalformed: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('yamlMalformed')).toEqual(EVERY_ARM);
});
it('yamlUnresolvedAlias: refuses its one pair alike in every arm', async () => {
  expect(await refusesAlike('yamlUnresolvedAlias')).toEqual(EVERY_ARM);
});
