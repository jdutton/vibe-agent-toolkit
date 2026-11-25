import { describe, expect, it } from 'vitest';

import { checkoutVatCacheDir } from '../src/run-vat.js';

describe('checkoutVatCacheDir', () => {
  it('passes VAT_CACHE_DIR through unchanged when it is set (CI sets its persisted cache root)', () => {
    expect(checkoutVatCacheDir({ VAT_CACHE_DIR: '/runner/temp/vat-cache' }, '/work/repo', '/tmp')).toBe('/runner/temp/vat-cache');
  });

  it.each([{}, { VAT_CACHE_DIR: '' }])('names a per-checkout directory under the temp directory for env %j', (env) => {
    expect(checkoutVatCacheDir(env, '/work/repo', '/tmp')).toMatch(/^\/tmp\/\.vat-cache-checkouts\/[0-9a-f]{16}$/u);
  });

  it('gives two checkouts two cache roots and one checkout the same root every time', () => {
    const first = checkoutVatCacheDir({}, '/work/repo/.claude/worktrees/a', '/tmp');
    expect(checkoutVatCacheDir({}, '/work/repo/.claude/worktrees/b', '/tmp')).not.toBe(first);
    expect(checkoutVatCacheDir({}, '/work/repo/.claude/worktrees/a', '/tmp')).toBe(first);
  });

  it('reads only VAT_CACHE_DIR from the environment', () => {
    const unset = checkoutVatCacheDir({}, '/work/repo', '/tmp');
    expect(checkoutVatCacheDir({ TMPDIR: '/elsewhere', VAT_CACHE: '0' }, '/work/repo', '/tmp')).toBe(unset);
  });
});
