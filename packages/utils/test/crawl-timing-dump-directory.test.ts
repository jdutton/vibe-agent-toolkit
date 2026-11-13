/**
 * A crawl-timing dump directory that cannot be made is reported once: the seam
 * turns itself off rather than registering an exit write, or keeping a test
 * write, that would only report the same failure again.
 *
 * The directory carries a NUL byte, so no platform makes it and nothing here
 * touches the disk.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** A directory no platform makes. */
const UNMAKEABLE = 'crawl-timing\0dump';

describe('a crawl-timing dump directory that cannot be made', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const seam = await import('../src/crawl-timing.js');
    seam.__setCrawlTimingForTest(null);
    vi.resetModules();
  });

  it('named at load, is reported once and registers no exit write', async () => {
    vi.stubEnv('VAT_CRAWL_TIMING', UNMAKEABLE);
    vi.resetModules();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listeners = process.listenerCount('exit');

    await import('../src/crawl-timing.js');

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^vat: crawl-timing dump failed for /);
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('named by the test seam, is reported once and writes nothing later', async () => {
    const seam = await import('../src/crawl-timing.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    seam.__setCrawlTimingForTest(UNMAKEABLE);

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(seam.__writeCrawlTimingDumpForTest()).toBeNull();
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
