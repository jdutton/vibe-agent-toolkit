/**
 * The pure rules behind the derived `ts_imports`: package, builtin and lexical target.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  bareSpecifierPackage,
  isBuiltinSpecifier,
  lexicalTargetOf,
} from '../src/projection/ts-imports.js';

describe('bareSpecifierPackage', () => {
  it.each([
    ['@a/b/c', '@a/b'],
    ['@a', '@a'],
    ['a/b', 'a'],
    ['a', 'a'],
    ['#x', null],
    ['./x', null],
    ['../x', null],
    ['/x', null],
    ['node:fs', null],
    ['https://x', null],
    // Ruled: a drive letter reads as a scheme, so the package is NULL (registered; no npm name has ':').
    ['C:/x', null],
    ['', null],
  ])('%s -> %s', (specifier, expected) => {
    expect(bareSpecifierPackage(specifier)).toBe(expected);
  });
});

/** Deterministic PRNG (mulberry32), so the property test needs no dependency and is reproducible. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST = 'abcdefghijklmnopqrstuvwxyz0123456789-~';
const REST = `${FIRST}._`;

/** One npm name part: first char from FIRST, the rest from REST (no leading '.' or '_'). */
function namePart(next: () => number): string {
  const pick = (alphabet: string): string => alphabet.charAt(Math.floor(next() * alphabet.length));
  const length = 1 + Math.floor(next() * 12);
  let part = pick(FIRST);
  for (let index = 1; index < length; index++) {
    part += pick(REST);
  }
  return part;
}

describe('bareSpecifierPackage equals the dependency name', () => {
  it('on every generated name, alone and with a subpath', () => {
    const next = prng(20_260_527);
    for (let index = 0; index < 2000; index++) {
      const name = next() < 0.5 ? namePart(next) : `@${namePart(next)}/${namePart(next)}`;
      expect(bareSpecifierPackage(name)).toBe(name);
      expect(bareSpecifierPackage(`${name}/${namePart(next)}/x.js`)).toBe(name);
    }
  });
});

describe('isBuiltinSpecifier', () => {
  it.each([
    ['fs', true],
    ['node:fs', true],
    ['node:nope', true], // by the prefix rule
    ['fsx', false],
  ])('%s -> %s', (specifier, expected) => {
    expect(isBuiltinSpecifier(specifier)).toBe(expected);
  });
});

describe('lexicalTargetOf', () => {
  it.each([
    ['a/b/c.ts', '../a/./b', 'a/a/b'],
    ['a/b/c.ts', './', 'a/b'],
    ['c.ts', './', '.'],
    ['a/b.ts', '..', '.'],
    ['a/b.ts', '../../x', '../x'],
    ['b.ts', '../x', '../x'],
    ['b.ts', '../../x', '../../x'],
    ['a/b.ts', 'pkg', null],
    ['a/b.ts', '/x', null],
    ['a/b.ts', '.x', null],
  ])('%s + %s -> %s', (path, specifier, expected) => {
    expect(lexicalTargetOf(path, specifier)).toBe(expected);
  });

  it('never touches the host: a seeded fold through safePath.resolve is host-dependent (red seed)', () => {
    const seeded = (path: string, specifier: string): string =>
      safePath.resolve(path.slice(0, path.lastIndexOf('/')), specifier);
    const target = lexicalTargetOf('a/b/c.ts', '../x');
    expect(target).toBe('a/x');
    // The seeded variant resolves against the host cwd, so it is absolute and differs from the pure fold.
    expect(seeded('a/b/c.ts', '../x')).not.toBe(target);
    expect(seeded('a/b/c.ts', '../x').endsWith('/a/x')).toBe(true);
  });
});
