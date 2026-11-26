/**
 * `blobRowBytes`: the logical bytes of one stored row, the unit the blob tier's
 * byte budget is kept in. Measured over the values a backend binds (after its
 * encoder), so a row read back measures what the row written measured.
 */

import { describe, expect, it } from 'vitest';

import { blobRowBytes } from '../src/projection/store-bookkeeping.js';

describe('blobRowBytes', () => {
  it('counts a string by its UTF-8 bytes, not its code units', () => {
    // 'é' is one code unit and two UTF-8 bytes; '😀' is two code units and four bytes.
    expect(blobRowBytes(['abc'])).toBe(3);
    expect(blobRowBytes(['é'])).toBe(2);
    expect(blobRowBytes(['😀'])).toBe(4);
  });

  it('counts a number and a bigint as eight bytes and null as none', () => {
    expect(blobRowBytes([0])).toBe(8);
    expect(blobRowBytes([1.5])).toBe(8);
    expect(blobRowBytes([2n ** 70n])).toBe(8);
    expect(blobRowBytes([null])).toBe(0);
  });

  it('counts a byte array by its length', () => {
    expect(blobRowBytes([new Uint8Array(5)])).toBe(5);
  });

  it('sums every value of the row', () => {
    expect(blobRowBytes(['ab', 1, null, 'é', new Uint8Array(3)])).toBe(2 + 8 + 0 + 2 + 3);
    expect(blobRowBytes([])).toBe(0);
  });
});
