import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/test/**/*.system.test.ts',
      'packages/*/src/**/*.system.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 120000, // System tests may take even longer
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        // Adaptive parallelism with conservative cap for CI stability
        // - Dev machines (10+ cores): Uses 4 cores
        // - CI machines (2-4 cores): Uses all available
        // - Windows VMs: Won't exceed 4 even if reporting more
        // - Respects container/cgroup limits (Docker, K8s)
        maxForks: Math.min(availableParallelism(), 4),
      },
    },
  },
});
