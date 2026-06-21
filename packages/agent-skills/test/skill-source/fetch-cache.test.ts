/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withCachedFetch } from '../../src/skill-source/fetch-cache.js';

describe('withCachedFetch', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = safePath.join(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-fc-')), 'cache');
  });

  afterEach(() => rmSync(dirname(cacheDir), { recursive: true, force: true }));

  const writeOne = async (dir: string): Promise<void> => {
    writeFileSync(safePath.join(dir, 'f.txt'), 'X');
  };
  const noopVerify = async (): Promise<void> => {};

  it('fetches on miss and creates the cache root 0700', async () => {
    const fetchInto = vi.fn(writeOne);
    const dir = await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto, verify: noopVerify });
    expect(statSync(safePath.join(dir, 'f.txt')).isFile()).toBe(true);
    expect(fetchInto).toHaveBeenCalledTimes(1);
    // Windows has no POSIX mode bits — the 0o700 enforcement is a no-op there.
    if (process.platform !== 'win32') {
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    }
  });

  it('does NOT re-fetch on a hit but DOES re-verify every time', async () => {
    const fetchInto = vi.fn(writeOne);
    const verify = vi.fn(noopVerify);
    const args = { cacheDir, digest: 'd1', key: 'k1', fetchInto, verify };
    await withCachedFetch(args);
    await withCachedFetch(args);
    expect(fetchInto).toHaveBeenCalledTimes(1); // cached
    expect(verify).toHaveBeenCalledTimes(2);     // verified on every hit
  });

  it('misses (re-fetches) when the digest changes — key includes the digest', async () => {
    const fetchInto = vi.fn(writeOne);
    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto, verify: noopVerify });
    await withCachedFetch({ cacheDir, digest: 'd2', key: 'k1', fetchInto, verify: noopVerify });
    expect(fetchInto).toHaveBeenCalledTimes(2);
  });

  it('propagates a verify failure (and does not return the dir)', async () => {
    const fetchInto = vi.fn(writeOne);
    const verify = vi.fn(async () => {
      throw new Error('integrity mismatch');
    });
    await expect(
      withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto, verify }),
    ).rejects.toThrow(/integrity mismatch/);
  });
});
