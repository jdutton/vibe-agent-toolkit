import { describe, expect, it } from 'vitest';

import { deepFreeze } from '../src/deep-freeze.js';

describe('deepFreeze', () => {
  it('freezes every object reachable from the value, and returns the value', () => {
    const value = { links: [{ href: 'a.md', location: { line: 1 } }], headings: [{ text: 'A', children: [] }] };

    expect(deepFreeze(value)).toBe(value);

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.links)).toBe(true);
    expect(Object.isFrozen(value.links[0])).toBe(true);
    expect(Object.isFrozen(value.links[0]?.location)).toBe(true);
    expect(Object.isFrozen(value.headings[0]?.children)).toBe(true);
  });

  it('makes a write anywhere inside the value throw', () => {
    const value = deepFreeze({ links: [{ resolvedId: undefined as string | undefined }] });
    const link = value.links[0];
    if (link === undefined) throw new Error('fixture has one link');

    expect(() => { link.resolvedId = 'x'; }).toThrow(TypeError);
    expect(() => { value.links.push({ resolvedId: 'y' }); }).toThrow(TypeError);
  });

  it('freezes the object holding a byte array and leaves the bytes, which cannot be frozen, as they are', () => {
    const value = { frontmatter: { blob: new Uint8Array([1, 2, 3]) } };

    expect(() => deepFreeze(value)).not.toThrow();
    expect(Object.isFrozen(value.frontmatter)).toBe(true);
    expect(() => { (value.frontmatter as { blob: Uint8Array }).blob = new Uint8Array(); }).toThrow(TypeError);
  });

  it('passes primitives and null through', () => {
    expect(deepFreeze('text')).toBe('text');
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
  });
});
