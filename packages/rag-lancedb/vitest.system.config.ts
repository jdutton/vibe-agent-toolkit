import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/system/**/*.system.test.ts'],
    testTimeout: 120000, // System tests may take longer (model download, CLI execution)
  },
});
