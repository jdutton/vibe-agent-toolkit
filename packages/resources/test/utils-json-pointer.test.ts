import { describe, expect, it } from 'vitest';

import {
  decodeJsonPointerSegment,
  encodeJsonPointerSegment,
  formatJsonPointerAsDotted,
} from '../src/utils.js';

describe('encodeJsonPointerSegment', () => {
  it('escapes ~ first then /', () => {
    expect(encodeJsonPointerSegment('a/b')).toBe('a~1b');
    expect(encodeJsonPointerSegment('a~b')).toBe('a~0b');
    expect(encodeJsonPointerSegment('a/~b')).toBe('a~1~0b');
  });
  it('passes through normal names', () => {
    expect(encodeJsonPointerSegment('foo')).toBe('foo');
    expect(encodeJsonPointerSegment('parent_prd')).toBe('parent_prd');
  });
});

describe('decodeJsonPointerSegment', () => {
  it('unescapes ~1 then ~0', () => {
    expect(decodeJsonPointerSegment('a~1b')).toBe('a/b');
    expect(decodeJsonPointerSegment('a~0b')).toBe('a~b');
    expect(decodeJsonPointerSegment('a~1~0b')).toBe('a/~b');
  });
});

describe('formatJsonPointerAsDotted', () => {
  it.each([
    { name: 'root pointer',                       pointer: '',                       expected: '' },
    { name: 'single property',                    pointer: '/foo',                   expected: 'foo' },
    { name: 'nested properties (dot-joined)',     pointer: '/foo/bar',               expected: 'foo.bar' },
    { name: 'numeric segment (array index)',      pointer: '/items/0',               expected: 'items[0]' },
    { name: 'array index then property',          pointer: '/adr-citations/0/adr',   expected: 'adr-citations[0].adr' },
    { name: 'multiple array indices',             pointer: '/matrix/0/1',            expected: 'matrix[0][1]' },
    { name: 'unescapes ~1 to /',                  pointer: '/foo~1bar',              expected: 'foo/bar' },
    { name: 'unescapes ~0 to ~',                  pointer: '/foo~0bar',              expected: 'foo~bar' },
    { name: 'leading-zero numeric → property',    pointer: '/items/01',              expected: 'items.01' },
  ])('formats $name', ({ pointer, expected }) => {
    expect(formatJsonPointerAsDotted(pointer)).toBe(expected);
  });
});
