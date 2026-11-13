/**
 * A parse-timing dump directory that cannot be made is reported once: the seam
 * turns itself off rather than registering an exit write, or keeping a test
 * write, that would only report the same failure again.
 *
 * The directory sits under this test file, an existing regular FILE, so making
 * it fails on every platform (ENOTDIR on POSIX; on Windows the parent cannot be
 * made a directory either) and nothing is ever created. Never a NUL byte: an
 * environment variable truncates at one, and in a forked worker (the Windows
 * unit pool) `process.env` is the real environment, so the value read back
 * names a directory that IS made.
 */

import { fileURLToPath } from 'node:url';
import type * as WorkerThreads from 'node:worker_threads';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A directory no platform makes: its parent is this file. */
const UNMAKEABLE = safePath.join(fileURLToPath(import.meta.url), 'dump');

describe('a parse-timing dump directory that cannot be made', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('node:worker_threads');
    const seam = await import('../src/parse-timing.js');
    seam.__setParseTimingForTest(null);
    vi.resetModules();
  });

  it('named at load, is reported once and registers no exit write', async () => {
    vi.stubEnv('VAT_PARSE_TIMING', UNMAKEABLE);
    // Only a process's main thread registers the exit write, and vitest runs
    // this file on a worker thread: load the module as the main thread would.
    vi.doMock('node:worker_threads', async (importOriginal) => ({
      ...(await importOriginal<typeof WorkerThreads>()),
      isMainThread: true,
    }));
    vi.resetModules();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listeners = process.listenerCount('exit');

    await import('../src/parse-timing.js');

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^vat: parse-timing dump failed for /);
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('named by the test seam, is reported once and writes nothing later', async () => {
    const seam = await import('../src/parse-timing.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    seam.__setParseTimingForTest(UNMAKEABLE);

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(seam.__writeParseTimingDumpForTest()).toBeNull();
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
