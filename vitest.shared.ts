/**
 * Shared platform-aware vitest settings.
 *
 * Unit vs. integration configs have different pool requirements:
 *   - Unit: threads on Mac/Unix (~20% faster collect); forks on Windows (process.chdir + native modules).
 *   - Integration: forks on ALL platforms (native modules like lancedb + process.chdir() don't
 *     survive the threads pool — teardown SIGABRTs on Unix).
 *
 * Windows additionally needs forks capped at 2 to prevent deadlocks / resource exhaustion; other
 * platforms leave parallelism unbounded.
 */

export const platformTestTimeout = process.platform === 'win32' ? 900_000 : 60_000; // 15min Windows, 1min Unix

export const unitPool = process.platform === 'win32' ? 'forks' : 'threads';
export const unitPoolOptions = {
  forks: { singleFork: false, maxForks: 2 },
};

export const integrationPool = 'forks' as const;
export const integrationPoolOptions = {
  forks: process.platform === 'win32'
    ? { singleFork: false, maxForks: 2 }
    : { singleFork: false },
};
