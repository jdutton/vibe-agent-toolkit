/**
 * `disposeTempDirSync` retries a transient refusal briefly. Its callers run on the way out of a
 * process that has just terminated a child; on Windows that child's handles in the directory are
 * released a moment after `TerminateProcess` returns, and a single-pass removal answered `EBUSY`
 * there. The retry is Node's own (`rmSync`'s `maxRetries`), so what is pinned is that it is asked
 * for, and bounded.
 */

import type * as Fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof Fs>()), rmSync: rmSyncMock }));

const { disposeTempDirSync } = await import('../src/tree-change/files.js');
const { normalizedTmpdir, safePath } = await import('../src/index.js');

describe('disposeTempDirSync — a transient refusal', () => {
  afterEach(() => {
    rmSyncMock.mockReset();
  });

  it('asks rmSync for a bounded retry, so an EBUSY a terminated child leaves for a moment does not leave the directory behind', () => {
    const dir = safePath.join(normalizedTmpdir(), 'vat-check-retry-probe');

    expect(disposeTempDirSync(dir)).toBeUndefined();

    expect(rmSyncMock).toHaveBeenCalledOnce();
    const options = rmSyncMock.mock.calls[0]?.[1] as Fs.RmOptions;
    expect(options).toMatchObject({ recursive: true, force: true });
    expect(options.maxRetries).toBeGreaterThan(0);
    // Bounded: linear backoff totals retryDelay × n(n+1)/2 — a dying process must still end promptly.
    const worstMs = (options.retryDelay ?? 100) * ((options.maxRetries ?? 0) * ((options.maxRetries ?? 0) + 1)) / 2;
    expect(worstMs).toBeLessThanOrEqual(500);
  });
});
