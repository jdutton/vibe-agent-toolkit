import { delimiter } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizedTmpdir, requireTestScratch, safePath, TEST_USER_STATE_UNDER, toForwardSlash } from '../src/index.js';

const TEMP = toForwardSlash(normalizedTmpdir());
/** A sibling of the temp directory: absolute on every platform, and never inside it. */
const OUTSIDE = safePath.resolve(TEMP, '..', 'vat-not-the-temp-tree', '.claude');
const REFUSED = /outside .* refusing to resolve it in a test process/;

describe('requireTestScratch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is armed by the shared vitest setup in this lane, with the temp directory in it', () => {
    const trees = (process.env[TEST_USER_STATE_UNDER] ?? '').split(delimiter).map((tree) => toForwardSlash(tree));
    expect(trees).toContain(TEMP);
  });

  it('answers a root inside the named tree, unchanged', () => {
    const inside = safePath.join(TEMP, 'case', '.claude');
    expect(requireTestScratch(inside, 'The Claude directory')).toBe(inside);
  });

  it('answers the tree itself', () => {
    expect(requireTestScratch(TEMP, 'The home directory')).toBe(TEMP);
  });

  it('throws for a root outside it, naming what it is and where it resolved', () => {
    expect(() => requireTestScratch(OUTSIDE, 'The Claude directory')).toThrow(REFUSED);
    expect(() => requireTestScratch(OUTSIDE, 'The Claude directory')).toThrow(`The Claude directory resolves to ${OUTSIDE}`);
  });

  it('throws for a root that only shares a name prefix with the tree', () => {
    expect(() => requireTestScratch(`${TEMP}-elsewhere/.claude`, 'The Claude directory')).toThrow(REFUSED);
  });

  it('accepts a root under ANY tree the variable lists', () => {
    const second = safePath.resolve(TEMP, '..', 'vat-second-tree');
    vi.stubEnv(TEST_USER_STATE_UNDER, [TEMP, second].join(delimiter));
    expect(requireTestScratch(safePath.join(second, 'home'), 'The home directory')).toBe(safePath.join(second, 'home'));
    expect(() => requireTestScratch(OUTSIDE, 'The home directory')).toThrow(REFUSED);
  });

  it.each(['', '   '])('does nothing when the variable is %j — no user sets it', (value) => {
    vi.stubEnv(TEST_USER_STATE_UNDER, value);
    expect(requireTestScratch(OUTSIDE, 'The Claude directory')).toBe(OUTSIDE);
  });

  it('does nothing when the variable is unset', () => {
    vi.stubEnv(TEST_USER_STATE_UNDER, undefined);
    expect(requireTestScratch(OUTSIDE, 'The Claude directory')).toBe(OUTSIDE);
  });
});
