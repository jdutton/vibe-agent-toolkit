/**
 * I0 defect seeds over the `data` instance: a NUL byte, malformed JSON, a comment in strict JSON,
 * closers that never match what they close, keys that differ only by a lone surrogate, and in YAML a
 * `%YAML 1.1` directive, malformed YAML and an alias naming no anchor, each planted alone into the clean data corpus. Each is exactly one DATA_FILE_NO_ROWS finding for its pair, with the same path,
 * state and code, in every arm (store-off, cold, warm, half the blob tier evicted),
 * judged by `vat resources check` and `vat resources query` (`../helpers/data-rows.ts` `dataDefectSeed`).
 */

import { expect, it } from 'vitest';

import { dataDefectRunner, EVERY_ARM } from '../helpers/data-rows.js';

const reportsAlike = dataDefectRunner(import.meta.url);

it('nulByte: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('nulByte')).toEqual(EVERY_ARM);
});
it('malformed: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('malformed')).toEqual(EVERY_ARM);
});
it('commentInStrict: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('commentInStrict')).toEqual(EVERY_ARM);
});
it('mismatchedCloser: is its own one finding alike in every arm, beside every other file\'s rows, without recursing into the parse', async () => {
  expect(await reportsAlike('mismatchedCloser')).toEqual(EVERY_ARM);
});
it('loneSurrogateKeys: is its own one finding alike in every arm, beside every other file\'s rows, rather than two keys colliding as text', async () => {
  expect(await reportsAlike('loneSurrogateKeys')).toEqual(EVERY_ARM);
});
it('yamlVersion11: is its own one finding alike in every arm, beside every other file\'s rows, rather than reading YAML 1.1 under 1.2', async () => {
  expect(await reportsAlike('yamlVersion11')).toEqual(EVERY_ARM);
});
it('yamlMalformed: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('yamlMalformed')).toEqual(EVERY_ARM);
});
it('yamlUnresolvedAlias: is its own one finding alike in every arm, beside every other file\'s rows', async () => {
  expect(await reportsAlike('yamlUnresolvedAlias')).toEqual(EVERY_ARM);
});
