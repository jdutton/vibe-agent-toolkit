/**
 * Shared platform-aware vitest settings.
 *
 * Centralizes Windows-specific timeout/pool config used by both unit and
 * integration test configs. Windows uses forks (required for process.chdir()
 * and native module isolation); Mac/Unix uses threads (shared module cache is
 * ~20% faster). Forks are capped at 2 on Windows to prevent resource
 * exhaustion / deadlock.
 */

export const platformTestTimeout = process.platform === 'win32' ? 900_000 : 60_000; // 15min Windows, 1min Unix

export const platformPool = process.platform === 'win32' ? 'forks' : 'threads';

export const platformPoolOptions = {
  forks: {
    singleFork: false,
    maxForks: 2,
  },
};
