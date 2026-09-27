/**
 * The decodable-size bound, as numbers.
 *
 * The bound itself is V8's maximum string length, so exercising it through a
 * real buffer costs half a gigabyte per case. The boundary is a pure function of
 * a byte count, and that is what is pinned here; the on-disk refusal (a sparse
 * file, no bytes read) is `integration/text-too-large.integration.test.ts`.
 */

import { constants } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { isVatError } from '../src/errors/vat-error.js';
import { TextTooLargeError } from '../src/text-content.js';
import { exceedsDecodableLength, MAX_DECODABLE_BYTES } from '../src/text-file.js';

describe('exceedsDecodableLength', () => {
  it('is the engine\'s own string-length limit, not a chosen number', () => {
    expect(MAX_DECODABLE_BYTES).toBe(constants.MAX_STRING_LENGTH);
  });

  it('admits a byte length exactly at the limit', () => {
    expect(exceedsDecodableLength(MAX_DECODABLE_BYTES)).toBe(false);
  });

  it('refuses one byte past the limit', () => {
    expect(exceedsDecodableLength(MAX_DECODABLE_BYTES + 1)).toBe(true);
  });

  it('admits the empty file', () => {
    expect(exceedsDecodableLength(0)).toBe(false);
  });
});

describe('TextTooLargeError', () => {
  it('is a coded VatError, so a catch dispatches on the code and never on the message', () => {
    const error = new TextTooLargeError(MAX_DECODABLE_BYTES + 1);

    expect(isVatError(error, TextTooLargeError.code)).toBe(true);
    expect(error.code).toBe('TEXT_TOO_LARGE');
    expect(error.byteLength).toBe(MAX_DECODABLE_BYTES + 1);
  });
});
