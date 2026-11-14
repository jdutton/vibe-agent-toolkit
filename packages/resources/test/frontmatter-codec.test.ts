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

/**
 * `toStrictEqual`'s verdict on a flat collection of primitives — the same
 * prototype and size, no hole and no extra own key, every member `Object.is`
 * the expected one (a set's and a map's by membership, as `toStrictEqual`
 * judges them) — without its per-member diff machinery, which over hundreds of
 * thousands of members costs more than the decode it checks.
 */
function expectSameFlatCollection(actual: unknown, expected: unknown): void {
  expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
  if (expected instanceof Set) {
    const set = actual as Set<unknown>;
    expect(set.size).toBe(expected.size);
    expect([...expected].filter((member) => !set.has(member))).toStrictEqual([]);
    return;
  }
  if (expected instanceof Map) {
    const map = actual as Map<unknown, unknown>;
    expect(map.size).toBe(expected.size);
    expect([...expected].filter(([key, value]) => !map.has(key) || !Object.is(map.get(key), value))).toStrictEqual([]);
    return;
  }
  if (Array.isArray(expected)) {
    const array = actual as unknown[];
    expect(array).toHaveLength(expected.length);
    expect(Object.keys(array)).toHaveLength(expected.length);
    const firstDifference = expected.findIndex((value, index) => !Object.hasOwn(array, index) || !Object.is(array[index], value));
    expect(firstDifference, `first element that differs: ${String(firstDifference)}`).toBe(-1);
    return;
  }
  const object = actual as Record<string, unknown>;
  const reference = expected as Record<string, unknown>;
  const keys = Object.keys(reference);
  expect(Object.keys(object)).toHaveLength(keys.length);
  const firstDifference = keys.find((key) => !Object.hasOwn(object, key) || !Object.is(object[key], reference[key]));
  expect(firstDifference, `first member that differs: ${String(firstDifference)}`).toBeUndefined();
}

/** {@link expectSameFlatCollection} under `{ a: … }`, the shape every scale case round-trips. */
function expectSameWrapped(actual: Record<string, unknown>, expected: { a: unknown }): void {
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Object.keys(actual)).toStrictEqual(['a']);
  expectSameFlatCollection(actual['a'], expected.a);
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

  it.each([
    ['an array', (items: number[]): unknown => items],
    ['a set', (items: number[]): unknown => new Set(items)],
    ['a map', (items: number[]): unknown => new Map(items.map((item) => [item, item]))],
    ['a mapping', (items: number[]): unknown => Object.fromEntries(items.map((item) => [`k${String(item)}`, item]))],
  ])('round-trips %s of 200,000 elements, past any argument-count or spread limit', (_label, build) => {
    const items = Array.from({ length: 200_000 }, (_, index) => index);
    const value = { a: build(items) };

    expectSameWrapped(roundTrip(value), value);
  });

  it('decodes an array of 2,000,000 elements, past the argument limit of any thread stack', () => {
    // 200,000 overflows a spread on Node's default main-thread stack, but a test
    // worker's stack is not that one, so the count alone could prove nothing
    // here. Two million arguments need 16 MB of stack, more than any thread VAT
    // or vitest starts, so a spread anywhere on the decode path is red here.
    const items = Array.from({ length: 2_000_000 }, (_, index) => index % 7);

    const value = { a: items };

    expectSameWrapped(roundTrip(value), value);
  });

  it('refuses a malformed encoding rather than inventing a value', () => {
    expect(() => decodeFrontmatterValue('["?", 1]')).toThrow(/frontmatter/i);
    expect(() => decodeFrontmatterValue('not json')).toThrow();
    expect(() => decodeFrontmatterValue('[1, 2]')).toThrow(/frontmatter/i);
  });
});
