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
  it('returns empty string for root pointer', () => {
    expect(formatJsonPointerAsDotted('')).toBe('');
  });
  it('formats single property', () => {
    expect(formatJsonPointerAsDotted('/foo')).toBe('foo');
  });
  it('formats nested properties with dots', () => {
    expect(formatJsonPointerAsDotted('/foo/bar')).toBe('foo.bar');
  });
  it('formats numeric segments as array indices', () => {
    expect(formatJsonPointerAsDotted('/items/0')).toBe('items[0]');
  });
  it('formats deep nested array index then property', () => {
    expect(formatJsonPointerAsDotted('/adr-citations/0/adr')).toBe('adr-citations[0].adr');
  });
  it('formats multiple array indices', () => {
    expect(formatJsonPointerAsDotted('/matrix/0/1')).toBe('matrix[0][1]');
  });
  it('unescapes RFC 6901 escapes (~1 -> /, ~0 -> ~)', () => {
    expect(formatJsonPointerAsDotted('/foo~1bar')).toBe('foo/bar');
    expect(formatJsonPointerAsDotted('/foo~0bar')).toBe('foo~bar');
  });
  it('treats leading-zero numeric segment as property name', () => {
    expect(formatJsonPointerAsDotted('/items/01')).toBe('items.01');
  });
});
