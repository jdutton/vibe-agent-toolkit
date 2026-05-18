import { describe, expect, it } from 'vitest';

import { jsonPointerToPath } from '../src/json-pointer-path.js';

describe('jsonPointerToPath', () => {
  it('returns empty array for empty pointer', () => {
    expect(jsonPointerToPath('')).toEqual([]);
  });

  it('returns single segment for /foo', () => {
    expect(jsonPointerToPath('/foo')).toEqual(['foo']);
  });

  it('returns nested segments for /foo/bar', () => {
    expect(jsonPointerToPath('/foo/bar')).toEqual(['foo', 'bar']);
  });

  it('converts canonical integers to numbers for array indices', () => {
    expect(jsonPointerToPath('/adrs-cited/0')).toEqual(['adrs-cited', 0]);
    expect(jsonPointerToPath('/items/12/name')).toEqual(['items', 12, 'name']);
  });

  it('keeps non-canonical integers as strings', () => {
    // Leading zeros are not canonical array indices per RFC 6901
    expect(jsonPointerToPath('/items/01')).toEqual(['items', '01']);
  });

  it('decodes RFC 6901 escapes', () => {
    // ~1 -> /, ~0 -> ~
    expect(jsonPointerToPath('/a~1b/~0c')).toEqual(['a/b', '~c']);
  });
});
