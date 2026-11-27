/**
 * `storedRowBytes`: the logical bytes of one stored row, the unit both stored tiers' byte budgets
 * are kept in. Measured over the values a backend binds (after its encoder), so a row read back
 * measures what the row written measured. And the bookkeeping declaration: one ledger per tier.
 */

import { describe, expect, it } from 'vitest';

import { STORE_BOOKKEEPING_TABLES, storedRowBytes } from '../src/projection/store-bookkeeping.js';

describe('storedRowBytes', () => {
  it('counts a string by its UTF-8 bytes, not its code units', () => {
    // 'é' is one code unit and two UTF-8 bytes; '😀' is two code units and four bytes.
    expect(storedRowBytes(['abc'])).toBe(3);
    expect(storedRowBytes(['é'])).toBe(2);
    expect(storedRowBytes(['😀'])).toBe(4);
  });

  it('counts a number and a bigint as eight bytes and null as none', () => {
    expect(storedRowBytes([0])).toBe(8);
    expect(storedRowBytes([1.5])).toBe(8);
    expect(storedRowBytes([2n ** 70n])).toBe(8);
    expect(storedRowBytes([null])).toBe(0);
  });

  it('counts a byte array by its length', () => {
    expect(storedRowBytes([new Uint8Array(5)])).toBe(5);
  });

  it('sums every value of the row', () => {
    expect(storedRowBytes(['ab', 1, null, 'é', new Uint8Array(3)])).toBe(2 + 8 + 0 + 2 + 3);
    expect(storedRowBytes([])).toBe(0);
  });
});

describe('STORE_BOOKKEEPING_TABLES', () => {
  it('declares the row-set ledger, keyed by the three fields of a row-set id', () => {
    expect(STORE_BOOKKEEPING_TABLES.rowSetKeys).toStrictEqual({
      name: 'row_set_keys',
      columns: [
        { name: 'contentKey', type: 'TEXT' },
        { name: 'instance', type: 'TEXT' },
        { name: 'variant', type: 'TEXT' },
        { name: 'writtenAt', type: 'TEXT' },
        { name: 'bytes', type: 'INTEGER' },
      ],
      primaryKey: ['contentKey', 'instance', 'variant'],
    });
  });

  it('holds exactly the three ledgers', () => {
    expect(Object.keys(STORE_BOOKKEEPING_TABLES)).toStrictEqual(['extents', 'blobKeys', 'rowSetKeys']);
  });
});
