import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    testTimeout: 30000, // Integration tests may take longer
  },
});
