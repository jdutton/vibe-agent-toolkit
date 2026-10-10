import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { isVatError, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FETCH_CACHE_NOT_OWNED_CODE, withCachedFetch } from '../../src/skill-source/fetch-cache.js';
import { useScratchTmpdir } from '../test-helpers.js';

describe('withCachedFetch', () => {
  let cacheDir: string;

  // A refresh and the parked-entry sweep remove recursively: the temp root they could reach is this scratch tree.
  const scratch = useScratchTmpdir('vat-fc-');
  beforeEach(() => {
    cacheDir = safePath.join(scratch(), 'cache');
  });

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

  it('re-fetches on a hit when refresh is true', async () => {
    const fetchInto = vi.fn(writeOne);
    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto, verify: noopVerify });
    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', refresh: true, fetchInto, verify: noopVerify });
    expect(fetchInto).toHaveBeenCalledTimes(2); // hit was purged then re-fetched
  });

  it('rethrows and removes the temp entry when fetchInto fails (no partial entry left)', async () => {
    const fetchInto = vi.fn(async () => {
      throw new Error('fetch exploded');
    });
    await expect(
      withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto, verify: noopVerify }),
    ).rejects.toThrow(/fetch exploded/);
    // No populated entry exists, so a retry with a working fetch must run fetchInto again.
    const retry = vi.fn(writeOne);
    const dir = await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto: retry, verify: noopVerify });
    expect(statSync(safePath.join(dir, 'f.txt')).isFile()).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    // Nothing but the entry: the failed fetch's staging went with it.
    expect(readdirSync(cacheDir)).toEqual(['k1-d1']);
  });

  it('a refresh whose fetch fails keeps the previous entry as it was', async () => {
    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto: writeOne, verify: noopVerify });
    const failing = vi.fn(async (dir: string) => {
      writeFileSync(safePath.join(dir, 'half.txt'), 'partial');
      throw new Error('network down');
    });

    await expect(withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', refresh: true, fetchInto: failing, verify: noopVerify })).rejects.toThrow(/network down/);

    expect(readdirSync(cacheDir)).toEqual(['k1-d1']);
    expect(readFileSync(safePath.join(cacheDir, 'k1-d1', 'f.txt'), 'utf8')).toBe('X');
  });

  it('sweeps previous entries a refresh left parked, and never a staged one another fetch may be filling', async () => {
    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto: writeOne, verify: noopVerify });
    const parked = safePath.join(cacheDir, '.k1-d1.vat-staged-0a1b2c3d.previous');
    const staged = safePath.join(cacheDir, '.k2-d1.vat-staged-4e5f6a7b');
    mkdirSyncReal(parked, { recursive: true });
    writeFileSync(safePath.join(parked, 'f.txt'), 'old');
    mkdirSyncReal(staged, { recursive: true });

    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto: writeOne, verify: noopVerify });

    expect(readdirSync(cacheDir).toSorted((a, b) => a.localeCompare(b))).toEqual(['.k2-d1.vat-staged-4e5f6a7b', 'k1-d1']);
  });

  // POSIX only: Windows has no uid, so there is nothing to own.
  it.skipIf(process.getuid === undefined)('refuses a cache another user owns, coded, without fetching or verifying', async () => {
    await withCachedFetch({ cacheDir, digest: 'd1', key: 'k1', fetchInto: writeOne, verify: noopVerify });
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(statSync(cacheDir).uid + 1);
    const fetchInto = vi.fn(writeOne);
    const verify = vi.fn(noopVerify);
    let refused: unknown;
    try {
      refused = await withCachedFetch({ cacheDir, digest: 'd2', key: 'k1', fetchInto, verify }).then(() => undefined, (error: unknown) => error);
    } finally {
      getuid.mockRestore();
    }
    expect(isVatError(refused, FETCH_CACHE_NOT_OWNED_CODE), String(refused)).toBe(true);
    expect(fetchInto).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(readdirSync(cacheDir)).toEqual(['k1-d1']);
  });
});
