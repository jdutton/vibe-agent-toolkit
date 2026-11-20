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

  it('freezes the objects inside a Map or Set, as in a YAML !!omap or !!set', () => {
    const inMap = { title: 'a' };
    const mapKey = { id: 'k' };
    const inSet = { title: 'b' };
    const value = { frontmatter: { omap: new Map<unknown, unknown>([['first', inMap], [mapKey, 1]]), set: new Set([inSet]) } };

    deepFreeze(value);

    expect(Object.isFrozen(value.frontmatter.omap)).toBe(true);
    expect(Object.isFrozen(inMap)).toBe(true);
    expect(Object.isFrozen(mapKey)).toBe(true);
    expect(Object.isFrozen(inSet)).toBe(true);
    expect(() => { inMap.title = 'x'; }).toThrow(TypeError);
  });

  it('leaves Map, Set and Date containers mutable: Object.freeze cannot stop .set, .add or .setTime', () => {
    const value = deepFreeze({ omap: new Map([['a', 1]]), set: new Set([1]), date: new Date(0) });

    value.omap.set('b', 2);
    value.set.add(2);
    value.date.setTime(1);

    expect(value.omap.get('b')).toBe(2);
    expect(value.set.has(2)).toBe(true);
    expect(value.date.getTime()).toBe(1);
  });

  it('passes primitives and null through', () => {
    expect(deepFreeze('text')).toBe('text');
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
  });
});
