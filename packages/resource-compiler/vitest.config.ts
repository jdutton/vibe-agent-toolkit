import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.integration.test.ts'],
    exclude: ['dist/**', 'node_modules/**', '**/*.system.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'dist/**',
        'test/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/test-fixtures/**',
      ],
    },
  },
});
