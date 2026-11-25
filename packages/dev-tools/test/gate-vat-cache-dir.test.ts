import { describe, expect, it } from 'vitest';

import { gateVatCacheDir } from '../src/gate-vat-cache-dir.js';

describe('gateVatCacheDir', () => {
  it('returns VAT_CACHE_DIR unchanged when it is set (CI sets its persisted cache root)', () => {
    expect(gateVatCacheDir('/runner/temp/vat-cache', '/work/repo', '/tmp')).toBe('/runner/temp/vat-cache');
  });

  it.each([undefined, ''])('names a per-checkout directory under the temp directory when VAT_CACHE_DIR is %j', (configured) => {
    expect(gateVatCacheDir(configured, '/work/repo', '/tmp')).toMatch(/^\/tmp\/\.vat-cache-checkouts\/[0-9a-f]{16}$/u);
  });

  it('gives two checkouts two cache roots and one checkout the same root every time', () => {
    const first = gateVatCacheDir(undefined, '/work/repo/.claude/worktrees/a', '/tmp');
    expect(gateVatCacheDir(undefined, '/work/repo/.claude/worktrees/b', '/tmp')).not.toBe(first);
    expect(gateVatCacheDir(undefined, '/work/repo/.claude/worktrees/a', '/tmp')).toBe(first);
  });
});
