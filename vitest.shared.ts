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
  // Unix unit pool is 'threads', whose cap knob is maxThreads (singleFork is forks-only).
  // Without this the intended 2-way cap was silently ignored and threads ran unbounded.
  threads: { singleThread: false, maxThreads: 2 },
};

export const integrationPool = 'forks' as const;
// Cap forks on ALL platforms. Integration files load native ML models (onnxruntime,
// transformers) + LanceDB Arrow engine, each ~1-3GB resident in NATIVE memory (not the JS
// heap, so provider.close() can't reclaim it — only worker exit does). Leaving Unix
// unbounded spawned ~availableParallelism (~10) such workers at once, swapping the machine
// and OOM-killing workers (surfaces as ERR_IPC_CHANNEL_CLOSED, not a test failure).
export const integrationPoolOptions = {
  forks: { singleFork: false, maxForks: 2 },
};
