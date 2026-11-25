/**
 * The one promise memo: the first caller's computation, its rejection included, is every later
 * caller's answer for the key.
 */

import { describe, expect, it, vi } from 'vitest';

import { memoized } from '../src/memoized.js';

describe('memoized', () => {
  it('computes once per key and hands every later caller the same promise', async () => {
    const memo = new Map<string, Promise<number>>();
    const compute = vi.fn(() => Promise.resolve(7));
    const first = memoized(memo, 'a', compute);
    const second = memoized(memo, 'a', compute);
    expect(second).toBe(first);
    expect(await second).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('computes each key apart', async () => {
    const memo = new Map<string, Promise<string>>();
    expect(await memoized(memo, 'a', () => Promise.resolve('a'))).toBe('a');
    expect(await memoized(memo, 'b', () => Promise.resolve('b'))).toBe('b');
    expect([...memo.keys()]).toEqual(['a', 'b']);
  });

  it('keeps a rejection: a later caller meets it and does not compute again', async () => {
    const memo = new Map<string, Promise<number>>();
    const failure = new Error('refused');
    const first = memoized(memo, 'a', () => Promise.reject(failure));
    await expect(first).rejects.toBe(failure);
    const retry = vi.fn(() => Promise.resolve(1));
    await expect(memoized(memo, 'a', retry)).rejects.toBe(failure);
    expect(retry).not.toHaveBeenCalled();
  });
});
