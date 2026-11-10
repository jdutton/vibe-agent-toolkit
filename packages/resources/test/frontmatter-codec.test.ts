/**
 * The decoded-frontmatter codec: what the worker sends and the cache stores, so
 * the parent rebuilds `frontmatter` without ever decoding YAML itself.
 *
 * The oracle is `yaml.parse` on the same source — the decode the worker runs —
 * and every value class `yaml` can hand back is pinned: the ones JSON cannot
 * carry (`.inf`, `.nan`, `-0`, `!!binary`, `!!set`, `!!omap`, `!!timestamp`),
 * shared and cyclic anchors, and a `__proto__` key. The encoded form must also
 * survive the structured clone between threads unchanged.
 */

import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { decodeFrontmatterValue, encodeFrontmatterValue } from '../src/frontmatter-codec.js';

/** Encode, clone across a thread boundary, decode. */
function roundTrip(value: Record<string, unknown>): Record<string, unknown> {
  return decodeFrontmatterValue(structuredClone(encodeFrontmatterValue(value)));
}

describe('the decoded-frontmatter codec', () => {
  it.each([
    ['plain keys', 'title: Hello\ntags: [a, b]\nnested: {x: 1, y: [true, null]}'],
    ['non-finite and negative-zero numbers', 'i: .inf\nn: -.inf\nnan: .nan\nz: -0\nf: 1.5'],
    ['a binary', 'b: !!binary aGVsbG8='],
    ['a set', 's: !!set {a, b}'],
    ['an ordered map', 'o: !!omap [{a: 1}, {b: 2}]'],
    ['a timestamp', 't: !!timestamp 2001-12-14t21:59:43.10-05:00'],
    ['a shared anchor', 'a: &x {k: 1}\nb: *x'],
    ['a __proto__ key', '__proto__: {polluted: 1}\nx: 1'],
    ['an empty mapping', '{}'],
  ])('rebuilds %s exactly as yaml decoded it', (_label, source) => {
    const decoded = yaml.parse(source) as Record<string, unknown>;

    expect(roundTrip(decoded)).toStrictEqual(decoded);
  });

  it('keeps a shared anchor shared', () => {
    const rebuilt = roundTrip(yaml.parse('a: &x {k: 1}\nb: *x') as Record<string, unknown>);

    expect(rebuilt['a']).toBe(rebuilt['b']);
  });

  it('rebuilds a cyclic anchor as a cycle', () => {
    const decoded = yaml.parse('a: &x [1, *x]') as { a: unknown[] };
    const rebuilt = roundTrip(decoded) as { a: unknown[] };

    expect(rebuilt.a[1]).toBe(rebuilt.a);
    expect(rebuilt).toStrictEqual(decoded);
  });

  it('gives a __proto__ key an own property, never a prototype', () => {
    const rebuilt = roundTrip(yaml.parse('__proto__: {polluted: 1}') as Record<string, unknown>);

    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype);
    expect(Object.hasOwn(rebuilt, '__proto__')).toBe(true);
  });

  it('encodes to a string, so its depth never meets a structured clone or a JSON reader', () => {
    expect(typeof encodeFrontmatterValue({ a: 1 })).toBe('string');
  });

  it('decodes a mapping nested far deeper than the thread stack could recurse', () => {
    let value: unknown = [];
    for (let depth = 0; depth < 50_000; depth += 1) value = [value];

    const rebuilt = roundTrip({ a: value });

    let depth = 0;
    let cursor: unknown = rebuilt['a'];
    while (Array.isArray(cursor) && cursor.length > 0) {
      cursor = cursor[0];
      depth += 1;
    }
    expect(depth).toBe(50_000);
  });

  it('refuses a malformed encoding rather than inventing a value', () => {
    expect(() => decodeFrontmatterValue('["?", 1]')).toThrow(/frontmatter/i);
    expect(() => decodeFrontmatterValue('not json')).toThrow();
    expect(() => decodeFrontmatterValue('[1, 2]')).toThrow(/frontmatter/i);
  });
});
