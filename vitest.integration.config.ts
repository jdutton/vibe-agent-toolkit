import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
    include: [
      'packages/*/test/**/*.integration.test.ts',
      'packages/*/src/**/*.integration.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: process.platform === 'win32' ? 900000 : 60000, // 15min Windows, 1min Unix
    passWithNoTests: true, // Allow passing when no integration tests exist yet
    // Threads on Mac/Unix: shared module cache = ~20% faster collect phase
    // Forks on Windows: required for process.chdir() compatibility and native module isolation
    pool: process.platform === 'win32' ? 'forks' : 'threads',
    poolOptions: {
      forks: {
        singleFork: false,
        // Limit to 2 workers on Windows (prevents resource exhaustion / deadlock)
        maxForks: 2,
      },
    },
  },
});
